// SPDX-License-Identifier: BUSL-1.1
// Build Drive file metadata for resumable upload.
// V1.7.0 — replaces the earlier YouTube uploader. Drive supports domain-level
// permission via permissions.create + timestamp deep-link via ?t=NmSs.
//
// Target folder + permission domain are tenant config (features.drive.folder_id,
// tenant.internal_domains[0]) — rendered into the DRIVE region below. The
// schema requires folder_id when features.drive.enabled is true, so an empty
// DRIVE_FOLDER_ID can only mean the workflow was deployed with the feature
// off (deploy gate would have skipped it) — fail loudly rather than upload
// into "My Drive" limbo.

// ── __TENANT_DRIVE_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const DRIVE_FOLDER_ID = ''; // Shared Drive / folder id (features.drive.folder_id)
const DRIVE_DOMAIN_RESTRICTED = true;
const DRIVE_PERMISSION_DOMAIN = 'acme.dev'; // tenant.internal_domains[0]
const TENANT_NAME = 'Acme Robotics';
// ── __TENANT_DRIVE_END__ ──

if (!DRIVE_FOLDER_ID) {
  throw new Error('[drive-uploader/metadata] DRIVE_FOLDER_ID is empty — set features.drive.folder_id in tenant.yaml and redeploy');
}

return $input.all().map(it => {
  const j = it.json;
  const topic = j.classification?.topic_slug
    ? j.classification.topic_slug.replace(/-/g, ' ')
    : (j.topic || 'Untitled meeting');
  const dateOnly = (j.start_time || '').slice(0, 10);
  const filename = dateOnly ? `${topic} – ${dateOnly}.mp4` : `${topic}.mp4`;

  const participants = Array.isArray(j.participants_lastnames) ? j.participants_lastnames.join(', ') : '';
  const duration = j.duration_min ? j.duration_min + ' min' : 'unknown';
  const description = [
    j.summary || j.classification?.slack_summary || '',
    '',
    '---',
    'Participants: ' + (participants || 'unknown'),
    'Duration: ' + duration,
    'Recorded: ' + (j.start_time || ''),
    '',
    '---',
    'Source: Zoom Cloud Recording → auto-uploaded via Backbrief (' + TENANT_NAME + ' pipeline).',
    DRIVE_DOMAIN_RESTRICTED && DRIVE_PERMISSION_DOMAIN
      ? 'Privacy: domain-restricted to ' + DRIVE_PERMISSION_DOMAIN + ' (Google Workspace SSO).'
      : 'Privacy: folder-inherited permissions.',
  ].filter(Boolean).join('\n');

  return { json: {
    ...j,
    drive_file_metadata: {
      name: filename,
      description,
      parents: [DRIVE_FOLDER_ID],
      mimeType: 'video/mp4',
    },
    drive_target_domain: DRIVE_DOMAIN_RESTRICTED ? DRIVE_PERMISSION_DOMAIN : null,
  }};
});
