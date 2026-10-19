// ChangeCatch settings page (app settings, account level).
// Docs: https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/extension-points/create-a-settings-page.md
// Components (all from @hubspot/ui-extensions, checked 2026-10-30 against the standard-components docs):
//   Tile, Accordion, Alert, ErrorState, Button (href {url, external}), Link, List, Tag, Checkbox, NumberInput.
// Toasts: actions.addAlert (supported on the `settings` extension point).
//   https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/ui-extensions-sdk/actions.md
// Data: hubspot.fetch to our app server. HubSpot adds ?portalId=&userId=&userEmail=&appId= and signs the request (v3);
//   the server trusts portalId only after checking that signature. Contract: docs/install-flow.md (GET/POST /api/settings).
//   https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data.md
// API_BASE must be listed (as a prefix) in app-hsmeta.json -> permittedUrls.fetch. HTTPS only, no localhost.
// Before upload: set API_BASE to the public server URL, and use the same URL in app-hsmeta.json permittedUrls.fetch and PUBLIC_BASE_URL on the server.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Divider,
  ErrorState,
  Flex,
  Heading,
  Link,
  List,
  LoadingSpinner,
  NumberInput,
  Tag,
  Text,
  Tile,
  hubspot,
} from '@hubspot/ui-extensions';

// ---- Constants (edit these) --------------------------------------------------------------------------------------
const API_BASE = 'https://REPLACE-WITH-PUBLIC-BASE-URL';
const SETTINGS_URL = `${API_BASE}/api/settings`;
/** Placeholder until the public user guide is hosted. */
const USER_GUIDE_URL = 'https://example.com/changecatch/user-guide';
const SUPPORT_EMAIL = 'support@changecatch.example';

/** Recommended preset = the install defaults (docs/install-flow.md, "Default watched pairs"). */
const RECOMMENDED_PAIRS: [string, string][] = [
  ['0-3', '0-1'], // Deal ↔ Contact
  ['0-3', '0-2'], // Deal ↔ Company
  ['0-2', '0-1'], // Company ↔ Contact
];

/** Fallback names if the server sends no label. */
const STANDARD_NAMES: Record<string, string> = {
  '0-1': 'Contacts',
  '0-2': 'Companies',
  '0-3': 'Deals',
  '0-5': 'Tickets',
};

// ---- Types (match GET /api/settings) -----------------------------------------------------------------------------
interface ObjectTypeOption {
  objectTypeId: string;
  label: string;
  custom: boolean;
  selectable?: boolean;
}
interface Pair {
  objectTypeId: string;
  associatedObjectTypeId: string;
}
interface SettingsView {
  portalId: number;
  objectTypes: ObjectTypeOption[];
  watchedPairs: Pair[];
  stampSpacingSeconds: number;
  spacingLimits: { min: number; max: number };
  lastProvisionError: string | null;
  customObjectsAvailable?: boolean;
  customObjectsEnabled?: boolean;
  enableCustomObjectsUrl?: string | null;
}
type AddAlert = (a: { title?: string; message: string; type?: 'info' | 'tip' | 'success' | 'warning' | 'danger' }) => void;

/** Direction-insensitive key, so "Deal-Contact" and "Contact-Deal" are the same checkbox. */
const keyOf = (a: string, b: string) => [a, b].sort().join('|');
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));

/** Turn any failure into a sentence an admin can act on. */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|timeout|timed out|abort|failed to|ECONN|unreachable|not json/i.test(msg)) {
    return "We couldn't reach the ChangeCatch server. It may be restarting. Wait a minute and try again.";
  }
  return msg;
}

async function callApi(method: 'GET' | 'POST', body?: unknown): Promise<SettingsView> {
  const res = await hubspot.fetch(SETTINGS_URL, {
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

hubspot.extend(({ actions }) => <ChangeCatchSettings addAlert={actions.addAlert as AddAlert} />);

function ChangeCatchSettings({ addAlert }: { addAlert: AddAlert }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [spacing, setSpacing] = useState<number>(3);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apply = (v: SettingsView) => {
    setView(v);
    setSelected(new Set(v.watchedPairs.map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId))));
    setSpacing(v.stampSpacingSeconds);
  };

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    callApi('GET')
      .then(apply)
      .catch((e) => setLoadError(friendlyError(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const nameOf = useCallback(
    (id: string) => view?.objectTypes.find((t) => t.objectTypeId === id)?.label || STANDARD_NAMES[id] || id,
    [view],
  );
  const typeOf = (id: string) => view?.objectTypes.find((t) => t.objectTypeId === id);
  const customEnabled = !!view?.customObjectsEnabled;
  const isLocked = (id: string) => {
    const t = typeOf(id);
    return !!t && (t.selectable === false || (t.custom && !customEnabled));
  };

  // Every unordered pair, grouped under the first object (standard objects first, then custom).
  const groups = useMemo(() => {
    const types = [...(view?.objectTypes ?? [])].sort((a, b) => Number(a.custom) - Number(b.custom));
    return types
      .map((a, i) => ({ object: a, partners: types.slice(i + 1) }))
      .filter((g) => g.partners.length > 0);
  }, [view]);

  const recommendedKeys = useMemo(() => {
    const ids = new Set(view?.objectTypes.map((t) => t.objectTypeId) ?? []);
    return new Set(RECOMMENDED_PAIRS.filter(([a, b]) => ids.has(a) && ids.has(b)).map(([a, b]) => keyOf(a, b)));
  }, [view]);

  const savedKeys = useMemo(
    () => new Set((view?.watchedPairs ?? []).map((p) => keyOf(p.objectTypeId, p.associatedObjectTypeId))),
    [view],
  );
  const dirty = !!view && (!sameSet(selected, savedKeys) || spacing !== view.stampSpacingSeconds);
  const isRecommended = sameSet(selected, recommendedKeys);

  const limits = view?.spacingLimits ?? { min: 1, max: 600 };
  const spacingValid = Number.isInteger(spacing) && spacing >= limits.min && spacing <= limits.max;

  const toggle = (k: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  };

  const save = async () => {
    if (!spacingValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const watchedPairs: Pair[] = [...selected].map((k) => {
        const [objectTypeId, associatedObjectTypeId] = k.split('|');
        return { objectTypeId, associatedObjectTypeId };
      });
      const v = await callApi('POST', { watchedPairs, stampSpacingSeconds: spacing });
      apply(v);
      addAlert({
        title: 'Settings saved',
        message: `ChangeCatch now watches ${v.watchedPairs.length} object pair(s).`,
        type: 'success',
      });
    } catch (e) {
      const msg = friendlyError(e);
      setSaveError(msg);
      addAlert({ title: "Couldn't save", message: msg, type: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  // ---- Loading / load error ------------------------------------------------------------------------------------
  if (loading && !view) return <LoadingSpinner label="Loading ChangeCatch settings…" showLabel layout="centered" />;

  if (loadError && !view) {
    return (
      <ErrorState title="ChangeCatch settings could not be loaded">
        <Text>{loadError}</Text>
        <Text>If this keeps happening, contact {SUPPORT_EMAIL}.</Text>
        <Button onClick={load}>Try again</Button>
      </ErrorState>
    );
  }
  if (!view) return null;

  const hasCustomTypes = view.objectTypes.some((t) => t.custom);

  // ---- Page ----------------------------------------------------------------------------------------------------
  return (
    <Flex direction="column" gap="medium">
      <Text>
        ChangeCatch notices when records are linked, unlinked, or their association label changes, and writes that
        change into the "ChangeCatch" properties on the record. Your workflows then start from those properties.
      </Text>

      {view.lastProvisionError && (
        <Alert title="Setup did not finish" variant="warning">
          {view.lastProvisionError} Click Save to try again. It is safe to repeat.
        </Alert>
      )}
      {saveError && (
        <Alert title="Your changes were not saved" variant="danger">
          {saveError}
        </Alert>
      )}

      {/* 1. Watched pairs */}
      <Tile>
        <Flex direction="column" gap="small">
          <Flex direction="row" justify="between" align="center" wrap="wrap" gap="small">
            <Heading>Watched pairs</Heading>
            <Flex direction="row" gap="small" align="center">
              {isRecommended && <Tag variant="success">Recommended</Tag>}
              <Button
                size="sm"
                variant="secondary"
                disabled={isRecommended || saving}
                onClick={() => setSelected(new Set(recommendedKeys))}
              >
                Use recommended
              </Button>
            </Flex>
          </Flex>
          <Text variant="microcopy">
            Tick each pair of objects you want ChangeCatch to watch. Recommended: Deals ↔ Contacts, Deals ↔ Companies,
            Companies ↔ Contacts. Watching a new object adds a "ChangeCatch" property group to it.
          </Text>

          {groups.map((g, i) => (
            <Flex key={g.object.objectTypeId} direction="column" gap="extra-small">
              {i > 0 && <Divider />}
              <Text format={{ fontWeight: 'bold' }}>
                {nameOf(g.object.objectTypeId)}
                {g.object.custom ? ' (custom object)' : ''}
              </Text>
              {g.partners.map((p) => {
                const k = keyOf(g.object.objectTypeId, p.objectTypeId);
                const locked = isLocked(g.object.objectTypeId) || isLocked(p.objectTypeId);
                return (
                  <Checkbox
                    key={k}
                    name={k}
                    checked={selected.has(k)}
                    readOnly={locked || saving}
                    description={locked ? 'Turn on custom objects below to watch this pair.' : undefined}
                    onChange={(on: boolean) => toggle(k, on)}
                  >
                    {nameOf(g.object.objectTypeId)} ↔ {nameOf(p.objectTypeId)}
                    {recommendedKeys.has(k) ? ' (recommended)' : ''}
                  </Checkbox>
                );
              })}
            </Flex>
          ))}
        </Flex>
      </Tile>

      {/* 2. Timing */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading>Timing</Heading>
          <NumberInput
            name="stampSpacingSeconds"
            label="Stamp spacing (seconds)"
            description="Minimum seconds between two stamps on the same record (keeps one workflow enrollment per change). Default 3. Leave it unless support asks you to change it."
            value={spacing}
            min={limits.min}
            max={limits.max}
            precision={0}
            error={!spacingValid}
            validationMessage={spacingValid ? undefined : `Enter a whole number from ${limits.min} to ${limits.max}.`}
            readOnly={saving}
            onChange={(v: number) => setSpacing(Number(v))}
          />
        </Flex>
      </Tile>

      {/* 3. Custom objects */}
      <Tile>
        <Flex direction="column" gap="small">
          <Flex direction="row" gap="small" align="center">
            <Heading>Custom objects</Heading>
            {customEnabled ? (
              <Tag variant="success">On</Tag>
            ) : (
              <Tag variant="default">Off</Tag>
            )}
          </Flex>
          {customEnabled && (
            <Text>
              ChangeCatch can watch your custom objects. {hasCustomTypes ? 'Pick their pairs above.' : 'No custom objects were found in this account yet.'}
            </Text>
          )}
          {!customEnabled && view.customObjectsAvailable && (
            <Alert title="Custom objects are turned off" variant="info">
              Your account has custom objects, but ChangeCatch was not given permission to update them. Custom-object
              pairs above are locked until you allow it. Click the button, approve the extra permission in HubSpot,
              then come back and refresh this page.
            </Alert>
          )}
          {!customEnabled && !view.customObjectsAvailable && (
            <Text>
              Custom objects need HubSpot Enterprise. If your account has them, you can still allow ChangeCatch to use
              them with the button below.
            </Text>
          )}
          {!customEnabled && (
            <Flex direction="row" gap="small">
              <Button
                variant="primary"
                disabled={!view.enableCustomObjectsUrl}
                href={view.enableCustomObjectsUrl ? { url: view.enableCustomObjectsUrl, external: true } : undefined}
              >
                Enable custom objects
              </Button>
              <Button variant="secondary" onClick={load} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </Button>
            </Flex>
          )}
          {!customEnabled && view.customObjectsAvailable && (
            // App governance: without super-admin approval HubSpot blocks the custom-object consent on its own page.
            <Text variant="microcopy">
              If your company requires app approval, a super admin must first allow ChangeCatch's custom-object
              permissions: Settings → Integrations → Connected Apps → Approved apps → ChangeCatch → Manage access.
            </Text>
          )}
        </Flex>
      </Tile>

      {/* Save bar */}
      <Flex direction="row" gap="small" align="center">
        <Button variant="primary" onClick={save} disabled={saving || !dirty || !spacingValid}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saving && <LoadingSpinner size="sm" label="Saving. This can take up to a minute." showLabel />}
        {!saving && dirty && <Tag variant="warning">Unsaved changes</Tag>}
      </Flex>

      {/* 4. Help */}
      <Tile>
        <Flex direction="column" gap="small">
          <Heading>Help</Heading>
          <Accordion title="How to build your first workflow" defaultOpen>
            <List variant="ordered-styled">
              <Text>
                Create a workflow for the object that changes (for example Deal-based). Trigger: "When an event
                occurs" &gt; "Property value changed" &gt; "ChangeCatch: last change ID" is known.
              </Text>
              <Text>
                Add your ChangeCatch conditions as filters on that trigger, for example "ChangeCatch: change type is any
                of LABEL_CHANGED".
              </Text>
              <Text>Turn re-enrollment ON for the trigger, add your actions, then review and publish.</Text>
            </List>
          </Accordion>
          <Text>
            Full guide with examples and troubleshooting:{' '}
            <Link href={{ url: USER_GUIDE_URL, external: true }}>ChangeCatch user guide</Link>
          </Text>
          <Text variant="microcopy">Need help? Email {SUPPORT_EMAIL}.</Text>
        </Flex>
      </Tile>
    </Flex>
  );
}
