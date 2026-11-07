import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store/db.js';
import { dedupeEntries, entryKey, toAssociationEntries } from './dedupe.js';
import { ev, file, REM, T0 } from '../../test/fixtures/journal.js';

// ---------- dedupe ----------

test('entryKey is stable and differs by offset, action and type', () => {
  const e = ev();
  assert.equal(entryKey('f1', e), entryKey('f1', { ...e }));
  assert.notEqual(entryKey('f1', e), entryKey('f2', e));
  assert.notEqual(entryKey('f1', e), entryKey('f1', { ...e, action: REM }));
  assert.notEqual(entryKey('f1', e), entryKey('f1', { ...e, associationTypeId: 99 }));
});

test('toAssociationEntries skips non-association events', () => {
  const f = file('f1', [ev()]);
  f.journalEvents.push({ type: 'crmObject', action: 'CREATE', objectTypeId: '0-1', objectId: 1, portalId: 1 });
  f.journalEvents.push({ type: 'app_lifecycle_event', action: 'APP_INSTALL', portalId: 1 });
  assert.equal(toAssociationEntries([f]).length, 1);
});

test('dedupe drops events already seen in the store and duplicates within the batch', () => {
  const store = new Store(':memory:');
  const [a, b] = toAssociationEntries([file('f1', [ev({ at: 0 }), ev({ at: 1 })])]);
  store.seen.markSeen([a.key], T0);
  const again = toAssociationEntries([file('f1', [ev({ at: 0 }), ev({ at: 1 }), ev({ at: 1 })])]);
  const out = dedupeEntries(again, store.seen);
  assert.deepEqual(out.map((e) => e.key), [b.key]);
});
