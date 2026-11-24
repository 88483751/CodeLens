export const syncMode = import.meta.env.MODE === 'browser-sync';
export const browserMode = syncMode || import.meta.env.MODE === 'browser';

let account = '';
export function setBrowserAccount(username: string) {
  account = username;
}

export function browserAccountStorageKey(key: string) {
  return syncMode ? `${key}:${account}` : key;
}
