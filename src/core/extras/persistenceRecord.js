import { cloneDeep } from 'lodash-es'

export function appPersistenceData(data, change = {}) {
  // Never read or traverse script state, including node proxies and their native getters.
  const record = { state: null }
  for (const key of ['id', 'type', 'blueprint', 'position', 'quaternion', 'scale', 'mover', 'uploader', 'pinned']) {
    record[key] = Object.prototype.hasOwnProperty.call(change, key) ? change[key] : data[key]
  }
  return record
}

export function persistenceRecord(data) {
  return { id: data.id, data: JSON.stringify(cloneDeep(data)) }
}
