import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ProjectService } from '../src/projects.mjs';

const hash = 'a'.repeat(64);
const project = () => ({ schemaVersion: 1, id: 'visionary-model', projectUrl: 'https://github.com/77kmp9jr2f-jpg/openFEA',
  title: 'Visionary', revision: 'v1', model: { filename: 'visionary.stl', sha256: hash },
  material: 'Manufacturer PLA profile, reviewed separately', orientation: 'Base on bed; Z upright',
  report: { filename: 'analysis.pdf', sha256: 'b'.repeat(64), modelSha256: hash },
  review: { status: 'reviewed', note: 'Model, material, and orientation reviewed for this report.' } });

test('project handoff persists with revision and report provenance across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'print-project-')); const path = join(dir, 'db.sqlite');
  let store = new Store(path);
  try {
    const p = new ProjectService(store).save(project(), { actor: 'operator', baseVersion: 0 });
    assert.equal(p.version, 1); assert.equal(p.analysisStatus, 'reviewed');
    assert.equal(p.updatedBy, 'operator'); assert.equal(p.nativeSolverVerified, false);
    store.close(); store = new Store(path);
    assert.deepEqual(new ProjectService(store).get(p.id), p);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('model, orientation, material, or revision edits invalidate retained analysis review', () => {
  const store = new Store(':memory:'); const svc = new ProjectService(store);
  try {
    for (const change of [p => p.model.sha256 = 'c'.repeat(64), p => p.orientation = 'Printed sideways',
      p => p.material = 'Unqualified PETG', p => p.revision = 'v2']) {
      const p = project(); p.id += String(svc.list().length);
      svc.save(p, { actor: 'operator', baseVersion: 0 }); change(p);
      const edited = svc.save(p, { actor: 'operator', baseVersion: 1 });
      assert.equal(edited.review.status, 'needs_review');
      assert.equal(edited.analysisStatus, 'stale');
      assert.equal(svc.history(p.id).length, 2);
    }
  } finally { store.close(); }
});

test('review requires an explicit new review and report tied to current model', () => {
  const store = new Store(':memory:'); const svc = new ProjectService(store);
  try {
    const p = project(); svc.save(p, { actor: 'operator', baseVersion: 0 }); p.model.sha256 = 'c'.repeat(64);
    svc.save(p, { actor: 'operator', baseVersion: 1 });
    assert.throws(() => svc.save(p, { actor: 'operator', baseVersion: 2, confirmReview: true }), /report.*model/i);
    p.report.modelSha256 = p.model.sha256;
    const reviewed = svc.save(p, { actor: 'operator', baseVersion: 2, confirmReview: true });
    assert.equal(reviewed.analysisStatus, 'reviewed'); assert.equal(reviewed.review.reviewedBy, 'operator');
  } finally { store.close(); }
});

test('reject malformed artifact identity, unsafe URLs, and conflicting edits without losing history', () => {
  const store = new Store(':memory:'); const svc = new ProjectService(store);
  try {
    for (const change of [p => p.model.sha256 = 'not-a-hash', p => p.projectUrl = 'javascript:alert(1)',
      p => p.model.filename = '../secret', p => p.schemaVersion = 2]) {
      const p = project(); change(p); assert.throws(() => svc.save(p, { actor: 'operator', baseVersion: 0 }));
    }
    svc.save(project(), { actor: 'operator', baseVersion: 0 });
    assert.throws(() => svc.save(project(), { actor: 'operator', baseVersion: 0 }), /version/i);
    assert.equal(svc.history('visionary-model').length, 1);
  } finally { store.close(); }
});

test('an absent report remains not attached and cannot count as reviewed analysis', () => {
  const store = new Store(':memory:'); const svc = new ProjectService(store);
  try {
    const p = project(); p.report = null; p.review = { status: 'needs_review', note: '' };
    assert.equal(svc.save(p, { actor: 'operator', baseVersion: 0 }).analysisStatus, 'not_attached');
    p.review.status = 'reviewed';
    assert.throws(() => svc.save(p, { actor: 'operator', baseVersion: 1, confirmReview: true }), /report/i);
  } finally { store.close(); }
});

test('editing an engineering review note invalidates the prior reviewer attribution', () => {
  const store = new Store(':memory:'); const svc = new ProjectService(store);
  try {
    const p = project(); svc.save(p, { actor: 'Alice', baseVersion: 0 });
    p.review.note = 'Bob changed the permitted use and engineering claim.';
    const updated = svc.save(p, { actor: 'Bob', baseVersion: 1 });
    assert.equal(updated.review.status, 'needs_review');
    assert.equal(updated.review.reviewedBy, undefined);
    const reviewed = svc.save(p, { actor: 'Bob', baseVersion: 2, confirmReview: true });
    assert.equal(reviewed.review.reviewedBy, 'Bob');
  } finally { store.close(); }
});
