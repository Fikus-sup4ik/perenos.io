'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../plugin/history-transfer.js');

test('parseCubBookmarksDump разбирает реальный формат CUB bookmarks/dump и разделяет history и viewed', () => {
  const dump = {
    version: 42,
    bookmarks: [
      {
        id: 101,
        cid: 1,
        card_id: 550,
        type: 'history',
        profile: 77,
        time: 1700000200,
        data: JSON.stringify({ id: 550, title: 'Fight Club', release_date: '1999-10-15' })
      },
      {
        id: 102,
        cid: 2,
        card_id: 550,
        type: 'viewed',
        profile: 77,
        time: 1700000300,
        data: JSON.stringify({ id: 550, title: 'Fight Club', release_date: '1999-10-15' })
      },
      {
        id: 103,
        cid: 3,
        card_id: 1399,
        type: 'wath',
        profile: 77,
        time: 1700000400,
        data: JSON.stringify({ id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones', number_of_seasons: 8 })
      },
      {
        id: 104,
        cid: 4,
        card_id: 1399,
        type: 'look',
        profile: 77,
        time: 1700000100,
        data: JSON.stringify({ id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones' })
      }
    ]
  };

  const res = Core.parseCubBookmarksDump(dump);
  assert.equal(res.profile.card.length, 2);
  assert.deepEqual(res.profile.history, [550]);
  assert.deepEqual(res.profile.viewed, [550]);
  assert.deepEqual(res.profile.wath, [1399]);
  assert.deepEqual(res.profile.look, [1399]);
  assert.deepEqual(res.missingCardIds, []);
});

test('validateAndDeduplicateProfile удаляет технические дубликаты и сохраняет порядок истории', () => {
  const raw = {
    card: [
      { id: 10, title: 'Movie A' },
      { id: 10, title: 'Movie A Duplicate' },
      { id: 20, name: 'Series B', original_name: 'Series B' }
    ],
    history: [20, 10, 20, 30],
    book: [10, 10],
    like: [],
    wath: [20],
    viewed: [10],
    scheduled: [],
    continued: [20],
    thrown: []
  };

  const res = Core.validateAndDeduplicateProfile(raw);
  assert.equal(res.profile.card.length, 2);
  assert.deepEqual(res.profile.history, [20, 10, 30]);
  assert.deepEqual(res.profile.book, [10]);
  assert.deepEqual(res.missingCardIds, [30]);
});

test('parseCubTimelineDump сохраняет прогресс серий, сезонов и временные метки', () => {
  const tlDump = {
    version: 15,
    timelines: {
      hash_ep_1: {
        duration: 3120.4,
        time: 1560.2,
        percent: 50.1,
        profile: 77,
        updated: 1732710000000,
        card: 'tv_1399',
        season: 1,
        episode: 3
      },
      hash_movie: {
        duration: 7200,
        time: 7200,
        percent: 100,
        profile: 77,
        updated: 1732700000000,
        card: 'movie_550'
      }
    }
  };

  const timeline = Core.parseCubTimelineDump(tlDump);
  assert.equal(timeline.hash_ep_1.duration, 3120);
  assert.equal(timeline.hash_ep_1.time, 1560);
  assert.equal(timeline.hash_ep_1.percent, 50);
  assert.equal(timeline.hash_ep_1.season, 1);
  assert.equal(timeline.hash_ep_1.episode, 3);
  assert.equal(timeline.hash_ep_1.card, 'tv_1399');
  assert.equal(timeline.hash_movie.percent, 100);
});

test('buildBackupPayload корректно обрабатывает пустую историю', () => {
  const backup = Core.buildBackupPayload({
    userId: 'user-1',
    profile: {},
    timeline: {}
  });

  assert.ok(backup.backupId);
  assert.equal(backup.formatVersion, '2.0.0');
  assert.equal(backup.stats.cardsCount, 0);
  assert.equal(backup.stats.historyCount, 0);
  assert.equal(backup.stats.timelineCount, 0);
  assert.ok(backup.stats.sizeBytes > 0);
});

test('buildBackupPayload корректно обрабатывает большую историю (500 карточек и 1000 таймкодов)', () => {
  const cards = [];
  const history = [];
  const timeline = {};

  for (let i = 1; i <= 500; i++) {
    const isTv = i % 2 === 0;
    cards.push(
      isTv
        ? { id: i, name: `Series ${i}`, original_name: `Series ${i}`, number_of_seasons: 3 }
        : { id: i, title: `Movie ${i}`, release_date: '2024-01-01' }
    );
    history.push(i);
  }

  for (let j = 1; j <= 1000; j++) {
    timeline[`h_${j}`] = {
      duration: 2400,
      time: 1200,
      percent: 50,
      updated: 1700000000 + j,
      card: `tv_${(j % 250) * 2 + 2}`,
      season: 1,
      episode: (j % 10) + 1
    };
  }

  const backup = Core.buildBackupPayload({
    userId: 'user-big',
    profile: { card: cards, history },
    timeline
  });

  assert.equal(backup.stats.cardsCount, 500);
  assert.equal(backup.stats.moviesCount, 250);
  assert.equal(backup.stats.seriesCount, 250);
  assert.equal(backup.stats.historyCount, 500);
  assert.equal(backup.stats.timelineCount, 1000);
  assert.equal(backup.stats.seriesTimelineCount, 1000);
});
