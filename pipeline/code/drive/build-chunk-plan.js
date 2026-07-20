// SPDX-License-Identifier: BUSL-1.1
// V1.7.7 — emit one item per chunk for SplitInBatches loop.
const init = $('Init Drive session').first().json;
const sessionLocation = (init.headers || {}).location;
const norm = $('Normalize webhook payload').first().json;
if (!sessionLocation) return [{ json: { __err: 'no-drive-session-url' } }];

const total = norm.mp4_file_size_bytes;
// V1.7.26 (2026-07-09): guard zero/NaN/absent MP4 size. Without this, the
// for-loop below produces 0 chunks → SplitInBatches gets an empty set →
// the recording is silently never uploaded and nothing errors. Surface it
// explicitly (same __err shape as the no-session guard) so the failure lands
// in the execution log instead of vanishing.
if (!(total > 0)) {
  return [{ json: { __err: 'invalid-mp4-size', mp4_file_size_bytes: total } }];
}
const CHUNK_SIZE = 8 * 1024 * 1024;
const mp4_url = norm.mp4_download_url;
const access_token = norm.mp4_access_token;
const downloadUrl = mp4_url + (mp4_url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(access_token);

const items = [];
let idx = 0;
for (let start = 0; start < total; start += CHUNK_SIZE) {
  const end = Math.min(start + CHUNK_SIZE, total) - 1;
  items.push({ json: {
    chunk_idx: idx++,
    start, end, total,
    is_last: end === total - 1,
    download_url: downloadUrl,
    session_url: sessionLocation,
    content_range: 'bytes ' + start + '-' + end + '/' + total,
    range_header: 'bytes=' + start + '-' + end,
  }});
}
console.log('[build-chunk-plan] ' + items.length + ' chunks for ' + total + ' bytes');
return items;
