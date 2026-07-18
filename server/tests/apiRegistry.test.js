const assert = require('node:assert/strict');
const test = require('node:test');

const { ENDPOINTS } = require('../apiRegistry');

function endpoint(type) {
  const value = ENDPOINTS.find((item) => item.type === type);
  assert.ok(value, `missing endpoint ${type}`);
  return value;
}

test('legacy video note detail uses Swagger detail with video type by default', () => {
  const ep = endpoint('get_note_detail_video');
  const first = ep.chain[0];

  assert.deepEqual(ep.chain.map((candidate) => candidate.upstream), ['swagger', 'datadrifter', 'xingyin']);
  assert.equal(first.upstream, 'swagger');
  assert.equal(first.path, '/api/v1/detail');
  assert.deepEqual(first.mapParams({ note_id: '6a0ae55400000000350212e6' }), {
    note_id: '6a0ae55400000000350212e6',
    node_type: 'video',
  });

  const note = { id: '6a0ae55400000000350212e6', type: 'video', video_info_v2: { media: {} } };
  const extracted = first.extractCore({ code: 0, data: [note] });
  assert.deepEqual(extracted, { ok: true, core: note });
  assert.deepEqual(JSON.parse(ep.shapeData(extracted.core, extracted.raw)), {
    code: 0,
    data: [{ comment_list: [], model_type: 'note', note_list: [note] }],
    msg: '成功',
    success: true,
  });
});

test('legacy note comment uses Swagger first while preserving its string response contract', () => {
  const ep = endpoint('get_note_comment');
  const first = ep.chain[0];

  assert.equal(first.upstream, 'swagger');
  assert.equal(first.path, '/api/v1/comments');
  assert.deepEqual(
    first.mapParams({
      note_id: '6718e886000000001b02c67c',
      start: '{"cursor":"next-hex","index":2}',
      sortStrategy: '2',
    }),
    {
      note_id: '6718e886000000001b02c67c',
      cursor: 'next-hex',
      sort: '最新',
    },
  );

  const core = { comments: [{ id: 'comment-1' }], cursor: 'next-hex', has_more: true };
  const extracted = first.extractCore({ code: 0, data: core });
  assert.equal(extracted.ok, true);
  const data = ep.shapeData(extracted.core, extracted.raw);
  assert.equal(typeof data, 'string');
  assert.deepEqual(JSON.parse(data), { success: true, msg: '', data: core, code: 0 });
});

test('legacy sub-comment uses Swagger first while preserving its string response contract', () => {
  const ep = endpoint('get_note_sub_comment');
  const first = ep.chain[0];

  assert.equal(first.upstream, 'swagger');
  assert.equal(first.path, '/api/v1/sub_comments');
  assert.deepEqual(
    first.mapParams({
      note_id: '6718e886000000001b02c67c',
      comment_id: '6722db7d000000001a0127c4',
      start: '{"cursor":"reply-hex","index":3}',
    }),
    {
      note_id: '6718e886000000001b02c67c',
      comment_id: '6722db7d000000001a0127c4',
      cursor: 'reply-hex',
    },
  );

  const core = { comments: [{ id: 'reply-1' }], cursor: 'reply-hex', has_more: false };
  const extracted = first.extractCore({ code: 0, data: core });
  assert.equal(extracted.ok, true);
  const data = ep.shapeData(extracted.core, extracted.raw);
  assert.equal(typeof data, 'string');
  assert.deepEqual(JSON.parse(data), { success: true, msg: '', data: core, code: 0 });
});
