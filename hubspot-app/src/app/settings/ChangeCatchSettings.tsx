// ChangeCatch settings page (app settings, account level).
// Docs: https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/extension-points/create-a-settings-page.md
//
// Layout follows HubSpot's UI-extension patterns (one primary button per surface, at the bottom; long tables page)
// plus the owner's choices of 2026-11-07 (sections in Tiles, no status line or intro copy; add a user-guide link back
// once the guide is hosted).
//   https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/ui-components/patterns/buttons.md
//
// Data: hubspot.fetch to our app server. HubSpot adds ?portalId=&userId=&userEmail=&appId= and signs the request (v3);
//   the server trusts portalId only after checking that signature. Contract: docs/install-flow.md (GET/POST /api/settings).
//   https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data.md
// Server URL: the PUBLIC_BASE_URL variable of the project config profile used for the upload (src/hsprofile.<env>.json),
//   read from context.variables. The same variable fills permittedUrls.fetch and redirectUrls in app-hsmeta.json, and must
//   equal PUBLIC_BASE_URL in the server's .env. HTTPS only, no localhost.
//   https://developers.hubspot.com/docs/developer-tooling/local-development/build-with-config-profiles.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Box,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Flex,
  Heading,
  Link,
  LoadingSpinner,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  Tile,
  hubspot,
} from '@hubspot/ui-extensions';

// ---- Constants ---------------------------------------------------------------------------------------------------
// Shown when the settings can't be loaded (so it can't come from GET /api/settings). Same address as
// app-hsmeta.json support.supportEmail (service/src/install/app-scopes.test.ts fails if they differ).
const SUPPORT_EMAIL = 'support@changecatch.example';

/** Pairs per table page: the list grows one row per pair, so it pages instead of growing without limit. */
const PAGE_SIZE = 10;

// ---- Types: the fields of GET /api/settings this page reads (service/src/install/settings.ts SettingsView; pinned
// by settings.test.ts there). Object types come in display order; names, defaults and spacing choices come from it.
interface Pair {
  objectTypeId: string;
  associatedObjectTypeId: string;
}
interface SettingsView {
  objectTypes: { objectTypeId: string; singular: string; plural: string; custom: boolean; selectable: boolean }[];
  watchedPairs: (Pair & { active: boolean })[];
  recommendedPairs: Pair[];
  stampSpacingSeconds: number;
  spacing: { default: number; min: number; max: number; presets: number[] };
  lastProvisionError: string | null;
  customObjectsAvailable: boolean;
  customObjectsEnabled: boolean;
  enableCustomObjectsUrl: string | null;
}
type AddAlert = (a: { title?: string; message: string; type?: 'info' | 'tip' | 'success' | 'warning' | 'danger' }) => void;

/** Direction-insensitive key: "Deals ↔ Contacts" and "Contacts ↔ Deals" are the same pair. */
const keyOf = (a: string, b: string) => [a, b].sort().join('|');
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Turn any failure into a sentence an admin can act on. */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|timeout|timed out|abort|failed to|ECONN|unreachable|not json/i.test(msg)) {
    return "ChangeCatch couldn't be reached. It may be restarting. Wait a minute, then try again.";
  }
  return msg;
}

async function callApi(settingsUrl: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<SettingsView> {
  const res = await hubspot.fetch(settingsUrl, {
    method,
    timeout: method === 'GET' ? 30000 : 120000, // creating properties on new objects can take a while
    ...(body ? { body } : {}),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error('Server response was not JSON');
  }
  if (!res.ok) throw new Error(json?.error ?? `The server answered with status ${res.status}.`);
  return json as SettingsView;
}

hubspot.extend(({ actions, context }) => (
  <ChangeCatchSettings
    addAlert={actions.addAlert as AddAlert}
    settingsUrl={`${String((context as { variables?: Record<string, string> }).variables?.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')}/api/settings`}
  />
));

function ChangeCatchSettings({ addAlert, settingsUrl }: { addAlert: AddAlert; settingsUrl: string }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [pairs, setPairs] = useState<string[]>([]); // pair keys, in display order
  const [spacing, setSpacing] = useState<number>(0);
  const [addFrom, setAddFrom] = useState<string>('');
  const [addTo, setAddTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apply = (v: SettingsView) => {
    setView(v);
    setPairs([...new Set(v.watchedPairs.map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId)))]);
    setSpacing(v.stampSpacingSeconds);
    setAddFrom('');
    setAddTo('');
  };

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    callApi(settingsUrl, 'GET')
      .then(apply)
      .catch((e) => setLoadError(friendlyError(e)))
      .finally(() => setLoading(false));
  }, [settingsUrl]);

  useEffect(load, [load]);

  /** Object types in the server's display order; an id the portal no longer lists sorts last, shown as its id. */
  const order = (id: string) => {
    const i = view?.objectTypes.findIndex((t) => t.objectTypeId === id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pluralOf = (id: string) => view?.objectTypes.find((t) => t.objectTypeId === id)?.plural ?? id;
  /** "Deals ↔ Contacts", in the server's display order. */
  const pairName = (k: string) =>
    k
      .split('|')
      .sort((a, b) => order(a) - order(b))
      .map(pluralOf)
      .join(' ↔ ');
  /** Saved pairs the server is not watching now (custom objects without custom-object access). */
  const inactiveKeys = useMemo(
    () => new Set((view?.watchedPairs ?? []).filter((p) => !p.active).map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId))),
    [view],
  );

  const customEnabled = !!view?.customObjectsEnabled;
  /** Object types the admin can pick now, in the server's display order. */
  const pickable = useMemo(() => (view?.objectTypes ?? []).filter((t) => t.selectable), [view]);
  const options = (exclude?: string) =>
    pickable
      .filter((t) => t.objectTypeId !== exclude)
      .filter((t) => !exclude || !pairs.includes(keyOf(exclude, t.objectTypeId))) // already watched: not offered
      .map((t) => ({ label: t.custom ? `${t.singular} (custom)` : t.singular, value: t.objectTypeId }));
  const partnerOptions = options(addFrom || undefined);

  const recommendedKeys = useMemo(
    () => (view?.recommendedPairs ?? []).map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId)),
    [view],
  );

  const savedKeys = useMemo(
    () => [...new Set((view?.watchedPairs ?? []).map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId)))],
    [view],
  );
  const dirty = !!view && (!sameList(pairs, savedKeys) || spacing !== view.stampSpacingSeconds);

  const spacingValid = !!view && Number.isInteger(spacing) && spacing >= view.spacing.min && spacing <= view.spacing.max;
  /** Presets instead of a free number box; a stored value that isn't a preset is kept as its own option. */
  const spacingOptions = [...new Set([...(view?.spacing.presets ?? []), ...(spacingValid ? [spacing] : [])])]
    .sort((a, b) => a - b)
    .map((n) => ({ label: `${n} second${n === 1 ? '' : 's'}${n === view?.spacing.default ? ' (recommended)' : ''}`, value: n }));

  const newKey = addFrom && addTo ? keyOf(addFrom, addTo) : '';
  const alreadyWatched = !!newKey && pairs.includes(newKey);

  const addPair = () => {
    if (!newKey || alreadyWatched) return;
    setPairs((p) => [newKey, ...p]); // newest first, so it shows on page 1 right under the picker
    setPage(1);
    setAddFrom('');
    setAddTo('');
  };
  const removePair = (k: string) => setPairs((p) => p.filter((x) => x !== k));
  const pageCount = Math.max(1, Math.ceil(pairs.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pager =
    pageCount > 1
      ? { paginated: true as const, pageCount, page: currentPage, onPageChange: setPage, showFirstLastButtons: false }
      : { paginated: false as const };

  const save = async () => {
    if (!spacingValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const watchedPairs: Pair[] = pairs.map((k) => {
        const [objectTypeId, associatedObjectTypeId] = k.split('|');
        return { objectTypeId, associatedObjectTypeId };
      });
      const v = await callApi(settingsUrl, 'POST', { watchedPairs, stampSpacingSeconds: spacing });
      apply(v);
      addAlert({ title: 'Settings saved', message: `Watching ${v.watchedPairs.length} pair${v.watchedPairs.length === 1 ? '' : 's'}.`, type: 'success' });
    } catch (e) {
      setSaveError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- Loading / load error ------------------------------------------------------------------------------------
  if (loading && !view) return <LoadingSpinner label="Loading settings" showLabel layout="centered" />;

  if (loadError && !view) {
    return (
      <ErrorState title="Settings couldn't be loaded">
        <Text>{loadError}</Text>
        <Text>If this keeps happening, email {SUPPORT_EMAIL}.</Text>
        <Button onClick={load}>Try again</Button>
      </ErrorState>
    );
  }
  if (!view) return null;

  // ---- Page ----------------------------------------------------------------------------------------------------
  return (
    <Flex direction="column" gap="large">
      {view.lastProvisionError && (
        <Alert title="Setup didn't finish" variant="warning">
          Click Save to try again. It's safe to repeat.
        </Alert>
      )}
      {saveError && (
        <Alert title="Changes weren't saved" variant="danger">
          {saveError}
        </Alert>
      )}

      {/* Watched pairs */}
      <Tile>
        <Flex direction="column" gap="medium">
          <Heading>Watched pairs</Heading>
          <Text>Link, unlink and label changes between these objects are written to the ChangeCatch properties.</Text>

          {/* Add a pair: full-width dropdowns, above the list */}
          <Flex direction="row" align="end" gap="small">
            <Box flex={1}>
              <Select
                name="addFrom"
                label="Object"
                placeholder="Choose an object"
                variant="input"
                options={options()}
                value={addFrom || undefined}
                readOnly={saving}
                onChange={(v) => {
                  setAddFrom(String(v));
                  if (String(v) === addTo) setAddTo('');
                }}
              />
            </Box>
            <Box flex={1}>
              <Select
                name="addTo"
                label="Linked to"
                placeholder={!addFrom ? 'Pick an object first' : partnerOptions.length ? 'Choose an object' : 'All pairs already watched'}
                variant="input"
                options={partnerOptions}
                value={addTo || undefined}
                readOnly={saving || !addFrom || partnerOptions.length === 0}
                onChange={(v) => setAddTo(String(v))}
              />
            </Box>
            <Button variant="secondary" onClick={addPair} disabled={!newKey || alreadyWatched || saving}>
              Add pair
            </Button>
          </Flex>


          {pairs.length === 0 ? (
            <EmptyState title="No pairs watched" imageName="multipleObjects" layout="horizontal" imageWidth={120}>
              <Text>Pick the objects to watch, or start with Deals, Contacts and Companies.</Text>
              {recommendedKeys.length > 0 && (
                <Button variant="secondary" onClick={() => setPairs(recommendedKeys)} disabled={saving}>
                  Use recommended pairs
                </Button>
              )}
            </EmptyState>
          ) : (
            <Table
              bordered
              density="condensed"
              {...pager}
            >
              <TableHead>
                <TableRow>
                  <TableHeader>Objects</TableHeader>
                  <TableHeader width="min" align="right">
                    {''}
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {pairs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((k) => (
                  <TableRow key={k}>
                    <TableCell>
                      <Text>{pairName(k)}</Text>
                      {inactiveKeys.has(k) && <Text variant="microcopy">Needs custom-object access</Text>}
                    </TableCell>
                    <TableCell width="min" align="right">
                      <Button variant="secondary" size="xs" onClick={() => removePair(k)} disabled={saving}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!customEnabled && view.customObjectsAvailable && view.enableCustomObjectsUrl && (
            <Text>
              Custom objects need extra access.{' '}
              <Link href={{ url: view.enableCustomObjectsUrl, external: true }}>Grant access</Link>
            </Text>
          )}
        </Flex>
      </Tile>

      {/* Advanced */}
      <Tile>
        <Accordion title="Advanced" size="sm">
          <Flex direction="column" gap="medium">
            <Flex direction="column" gap="small">
              <Text variant="microcopy">Fine-tune how ChangeCatch stamps your records.</Text>
              <Divider />
            </Flex>
            <Flex direction="row" align="center" gap="extra-large">
              <Box flex={2}>
                <Flex direction="column" gap="extra-small">
                  <Text format={{ fontWeight: 'bold' }}>Stamp spacing</Text>
                  <Flex direction="column" gap="flush">
                    <Text variant="microcopy">The shortest gap between two stamps on the same record,</Text>
                    <Text variant="microcopy">so each change starts its own workflow run.</Text>
                  </Flex>
                </Flex>
              </Box>
              <Box flex={1}>
                <Select
                  name="stampSpacingSeconds"
                  variant="input"
                  options={spacingOptions}
                  value={spacing}
                  readOnly={saving}
                  onChange={(v) => setSpacing(Number(v))}
                />
              </Box>
            </Flex>
          </Flex>
        </Accordion>
      </Tile>

      {/* Save */}
      <Flex direction="row" justify="end" align="center" gap="small">
        {saving ? (
          <LoadingSpinner size="sm" label="This can take up to a minute" showLabel />
        ) : (
          dirty && <Text variant="microcopy">Unsaved changes</Text>
        )}
        <Button variant="primary" onClick={save} disabled={saving || !dirty || !spacingValid}>
          {saving ? 'Saving' : 'Save'}
        </Button>
      </Flex>
    </Flex>
  );
}
