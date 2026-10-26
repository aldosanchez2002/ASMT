// Minimal Firestore REST client that writes with the public web API key.
// Firestore treats these as unauthenticated requests, so it only works while
// the Firestore rules allow public writes (prototype mode).

import { firebaseConfig } from '../web/firebase-config.js';

const { projectId, apiKey } = firebaseConfig;
export const docsPath = `projects/${projectId}/databases/(default)/documents`;

// Converts a plain JS value to Firestore's REST value format.
export function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFields(value) } };
  return { stringValue: String(value) };
}

export function toFields(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]),
  );
}

// A "set" write that replaces the whole document, optionally stamping a
// server timestamp into `timestampField`.
export function setWrite(path, data, timestampField) {
  const write = { update: { name: `${docsPath}/${path}`, fields: toFields(data) } };
  if (timestampField) {
    write.updateTransforms = [{ fieldPath: timestampField, setToServerValue: 'REQUEST_TIME' }];
  }
  return write;
}

export function deleteWrite(path) {
  return { delete: `${docsPath}/${path}` };
}

// Commits writes in atomic batches of up to 500.
export async function commit(writes) {
  for (let i = 0; i < writes.length; i += 500) {
    const res = await fetch(`https://firestore.googleapis.com/v1/${docsPath}:commit?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: writes.slice(i, i + 500) }),
    });
    if (!res.ok) {
      const body = await res.text();
      const hint = res.status === 403
        ? '\nFirestore rules are blocking public writes. Either allow them, or add a FIREBASE_SERVICE_ACCOUNT secret.'
        : '';
      throw new Error(`Firestore write failed: ${res.status} ${body}${hint}`);
    }
  }
}

// Merges only the listed fields into a document (creating it if needed),
// leaving every other field untouched. `fields` is { 'a.`b-c`': value } style
// paths mapped to values; nested maps are built from the dotted paths.
export function mergeWrite(path, fieldValues) {
  const fields = {};
  for (const [fieldPath, value] of Object.entries(fieldValues)) {
    const parts = fieldPath.match(/`[^`]+`|[^.]+/g).map((p) => p.replace(/`/g, ''));
    let target = fields;
    parts.slice(0, -1).forEach((p) => {
      target[p] ??= { mapValue: { fields: {} } };
      target = target[p].mapValue.fields;
    });
    target[parts.at(-1)] = toValue(value);
  }
  return {
    update: { name: `${docsPath}/${path}`, fields },
    updateMask: { fieldPaths: Object.keys(fieldValues) },
  };
}

// Converts a Firestore REST value back to a plain JS value.
export function fromValue(v) {
  const [type, x] = Object.entries(v)[0];
  if (type === 'mapValue') return Object.fromEntries(Object.entries(x.fields ?? {}).map(([k, y]) => [k, fromValue(y)]));
  if (type === 'arrayValue') return (x.values ?? []).map(fromValue);
  if (type === 'integerValue') return Number(x);
  if (type === 'nullValue') return null;
  return x;
}

// Reads every document in a collection as { id: data }.
export async function listDocs(collection) {
  const docs = {};
  let pageToken;
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/${docsPath}/${collection}`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore read of ${collection} failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      docs[d.name.split('/').pop()] = fromValue({ mapValue: { fields: d.fields ?? {} } });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return docs;
}
