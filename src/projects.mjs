import { CommandError } from './commands.mjs';

function text(value, name, max = 1000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new CommandError(`Invalid ${name}`);
  return value.trim();
}
function artifact(value, name) {
  const filename = text(value?.filename, `${name} filename`, 255);
  if (/[\\/]/.test(filename) || filename === '.' || filename === '..') throw new CommandError(`Invalid ${name} filename`);
  if (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) throw new CommandError(`Invalid ${name} SHA-256`);
  return { filename, sha256: value.sha256.toLowerCase() };
}
const context = p => JSON.stringify([p.model.sha256, p.material, p.orientation, p.revision]);

export class ProjectService {
  constructor(store) { this.store = store; }
  save(input, { actor, baseVersion, confirmReview = false }) {
    if (input?.schemaVersion !== 1 || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.id)) throw new CommandError('Invalid project handoff version or id');
    text(actor, 'actor', 100);
    const projectUrl = text(input.projectUrl, 'project URL', 2000);
    let url;
    try { url = new URL(projectUrl); } catch { throw new CommandError('Invalid project URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new CommandError('Project URL must be HTTPS without credentials');
    const p = { schemaVersion: 1, id: input.id, projectUrl, title: text(input.title, 'title', 200),
      revision: text(input.revision, 'revision', 200), model: artifact(input.model, 'model'),
      material: text(input.material, 'material'), orientation: text(input.orientation, 'orientation'),
      report: input.report == null ? null : { ...artifact(input.report, 'report'), modelSha256: text(input.report.modelSha256, 'report model hash', 64).toLowerCase() },
      review: { status: input.review?.status, note: text(input.review?.note ?? '', 'review note', 2000, true) },
      updatedBy: actor, nativeSolverVerified: false };
    if (p.report && !/^[a-f0-9]{64}$/.test(p.report.modelSha256)) throw new CommandError('Invalid report model hash');
    if (!['needs_review', 'reviewed'].includes(p.review.status)) throw new CommandError('Invalid review status');
    const current = this.get(p.id);
    if (baseVersion !== (current?.version ?? 0)) throw new CommandError('Project version conflict; reload before editing', 409);
    const changed = current && (context(current) !== context(p) || JSON.stringify(current.report) !== JSON.stringify(p.report) || current.review.note !== p.review.note);
    const pendingReview = current?.review.status === 'needs_review';
    if (current && (changed || pendingReview) && !confirmReview) p.review.status = 'needs_review';
    if (p.review.status === 'reviewed') {
      if (!p.report || p.report.modelSha256 !== p.model.sha256) throw new CommandError('Reviewed report must reference the current model hash');
      if (p.review.note.length < 10) throw new CommandError('Provide a meaningful review note');
      p.review.reviewedBy = confirmReview || !current ? actor : current.review.reviewedBy;
      p.review.reviewedAt = confirmReview || !current ? Date.now() : current.review.reviewedAt;
    }
    p.analysisStatus = !p.report ? 'not_attached' : p.review.status === 'reviewed' ? 'reviewed' :
      (changed || current?.analysisStatus === 'stale' || p.report.modelSha256 !== p.model.sha256) ? 'stale' : 'needs_review';
    return this.store.saveRecord('project', p, baseVersion);
  }
  get(id) { return this.store.getRecord('project', id); }
  list() { return this.store.listRecords('project'); }
  history(id) { return this.store.recordHistory('project', id); }
}
