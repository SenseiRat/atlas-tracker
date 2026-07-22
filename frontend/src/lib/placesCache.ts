import type { Place, PlaceType } from '../types';

/**
 * Tiny IndexedDB-backed cache for the place lists. These lists are large
 * (tens of thousands of cities) but change rarely, so we persist each type's
 * fully-loaded array across sessions. On revisit the UI can paint from this
 * cache immediately while the network refresh happens in the background
 * (stale-while-revalidate), instead of showing a blank list until the full
 * download completes.
 */

const DB_NAME = 'atlas-places-cache';
const STORE = 'places';
const DB_VERSION = 1;

// Bump when the serialized Place shape changes in a way that would make old
// cached entries invalid; stale-version rows are ignored (and overwritten).
const SCHEMA_VERSION = 1;

type CacheRecord = {
  type: PlaceType;
  schemaVersion: number;
  savedAt: number;
  items: Place[];
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'type' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

/** Returns the cached list for a type, or null if absent/stale/unavailable. */
export async function readCachedPlaces(type: PlaceType): Promise<Place[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(type);
      req.onsuccess = () => {
        const record = req.result as CacheRecord | undefined;
        if (!record || record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.items)) {
          resolve(null);
          return;
        }
        resolve(record.items);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Persists a fully-loaded list for a type. Best-effort; failures are ignored. */
export async function writeCachedPlaces(type: PlaceType, items: Place[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const record: CacheRecord = { type, schemaVersion: SCHEMA_VERSION, savedAt: Date.now(), items };
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
