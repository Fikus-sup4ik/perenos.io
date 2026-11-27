'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../plugin/history-transfer.js');

test('mergeProfiles безопасно объединяет профили без потери существующих данных нового аккаунта', () => {
  const target = {
    card: [{ id: 1, title: 'Existing Movie' }],
    history: [1],
    book: [1],
    like: [],
    wath: [],
    viewed: [],
    scheduled: [],
    continued: [],
    thrown: []
  };

  const incoming = {
    card: [
      { id: 1, title: 'Existing Movie' },
      { id: 2, name: 'Imported Series', original_name: 'Imported Series' }
    ],
    history: [2, 1],
    book: [2],
    like: [2],
    wath: [2],
    viewed: [1],
    scheduled: [],
    continued: [2],
    thrown: []
  };

  const res = Core.mergeProfiles(target, incoming, 'merge');
  assert.equal(res.merged.card.length, 2);
  assert.deepEqual(res.merged.history, [1, 2]);
  assert.deepEqual(res.merged.book, [1, 2]);
  assert.deepEqual(res.merged.wath, [2]);
  assert.deepEqual(res.merged.viewed, [1]);
  assert.equal(res.stats.addedCards, 1);
  assert.equal(res.stats.existedCards, 1);
});

test('повторный импорт одной и той же резервной копии не создаёт дубликатов', () => {
  const backupProfile = {
    card: [{ id: 100, title: 'Dune' }],
    history: [100],
    book: [100],
    like: [],
    wath: [],
    viewed: [100],
    scheduled: [],
    continued: [],
    thrown: []
  };

  const first = Core.mergeProfiles({}, backupProfile, 'merge').merged;
  const second = Core.mergeProfiles(first, backupProfile, 'merge');

  assert.equal(second.merged.card.length, 1);
  assert.deepEqual(second.merged.history, [100]);
  assert.equal(second.stats.addedCards, 0);
  assert.equal(second.stats.existedCards, 1);

  const ops = Core.prepareImportOperations(first, backupProfile, 'merge');
  assert.equal(ops.operations.length, 0);
  assert.equal(ops.existedCount, 3);
});

test('mergeTimelines сохраняет более свежий прогресс серий', () => {
  const target = {
    ep_1: { duration: 3000, time: 500, percent: 17, updated: 1000, card: 'tv_10', season: 1, episode: 1 },
    ep_2: { duration: 3000, time: 2900, percent: 97, updated: 5000, card: 'tv_10', season: 1, episode: 2 }
  };

  const incoming = {
    ep_1: { duration: 3000, time: 2800, percent: 93, updated: 2000, card: 'tv_10', season: 1, episode: 1 },
    ep_2: { duration: 3000, time: 100, percent: 3, updated: 1000, card: 'tv_10', season: 1, episode: 2 },
    ep_3: { duration: 3000, time: 1500, percent: 50, updated: 3000, card: 'tv_10', season: 1, episode: 3 }
  };

  const res = Core.mergeTimelines(target, incoming, 'merge');
  assert.equal(res.merged.ep_1.percent, 93); // incoming новее
  assert.equal(res.merged.ep_2.percent, 97); // existing новее
  assert.equal(res.merged.ep_3.percent, 50); // добавлен новый эпизод
  assert.equal(res.stats.added, 1);
  assert.equal(res.stats.updated, 1);
  assert.equal(res.stats.keptExisting, 1);
});

test('prepareImportOperations формирует операции в обратном порядке для сохранения хронологии', () => {
  const incoming = {
    card: [{ id: 1, title: 'Newest' }, { id: 2, title: 'Older' }],
    history: [1, 2],
    book: [],
    like: [],
    wath: [],
    viewed: [],
    scheduled: [],
    continued: [],
    thrown: []
  };

  const prep = Core.prepareImportOperations({}, incoming, 'merge');
  assert.equal(prep.operations.length, 2);
  assert.equal(prep.operations[0].card_id, 2);
  assert.equal(prep.operations[1].card_id, 1);
});

test('verifyImportResult выявляет несоответствие если данные не были записаны', () => {
  const expectedProfile = {
    card: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
    history: [1, 2],
    book: [2],
    like: [],
    wath: [],
    viewed: [],
    scheduled: [],
    continued: [],
    thrown: []
  };
  const actualProfile = {
    card: [{ id: 1, title: 'A' }],
    history: [1],
    book: [],
    like: [],
    wath: [],
    viewed: [],
    scheduled: [],
    continued: [],
    thrown: []
  };

  const check = Core.verifyImportResult(
    expectedProfile,
    actualProfile,
    { ep1: { duration: 100, time: 50, percent: 50, updated: 1 } },
    {}
  );

  assert.equal(check.ok, false);
  assert.deepEqual(check.missingByCategory.history, [2]);
  assert.deepEqual(check.missingByCategory.book, [2]);
  assert.deepEqual(check.missingTimelines, ['ep1']);
});

test('validateBackupForImport отклоняет несовместимый формат', () => {
  assert.throws(() => {
    Core.validateBackupForImport({ formatVersion: '99.0.0', profile: { card: [] } });
  }, (err) => err.code === Core.ERROR_CODES.INCOMPATIBLE_FORMAT);
});
