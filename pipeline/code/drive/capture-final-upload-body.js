// SPDX-License-Identifier: BUSL-1.1
// V1.7.8 — emit full upload response on every chunk. IF node downstream
// routes 200/201 to final path; 308 back to SplitInBatches.
const uploadResp = $json;
const ctx = $('Split chunks (1 at a time)').item.json;
const sc = uploadResp.statusCode || 0;

// Forward statusCode + body so IF + Build root post update can read.
return { json: {
  statusCode: sc,
  body: uploadResp.body || null,
  chunk_idx: ctx.chunk_idx,
  is_last: ctx.is_last,
  chunks_done: ctx.chunk_idx + 1,
}};
