import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed, BlockedCallError } from '../src/allowlist.js';

const A = '/accounts/acct';
const bucket = `${A}/r2/buckets/my-bucket`;

test('DELETE 一律被拒，无论路径多无害', () => {
  for (const path of [`${A}/workers/scripts`, `${bucket}/domains/custom/x.test`, '/zones/z1']) {
    assert.throws(() => assertAllowed('DELETE', path), BlockedCallError, path);
  }
});

test('触碰 R2 对象的调用被拒', () => {
  for (const method of ['GET', 'PUT', 'POST', 'PATCH']) {
    assert.throws(() => assertAllowed(method, `${bucket}/objects/song.flac`), BlockedCallError);
  }
});

test('改生命周期规则被拒（会级联删对象）', () => {
  assert.throws(() => assertAllowed('PUT', `${bucket}/lifecycle`), BlockedCallError);
});

test('未收录的端点默认被拒而不是放行', () => {
  assert.throws(() => assertAllowed('POST', `${A}/r2/buckets`), BlockedCallError);
  assert.throws(() => assertAllowed('PUT', `${A}/workers/scripts/app`), BlockedCallError);
  assert.throws(() => assertAllowed('GET', '/user/tokens'), BlockedCallError);
});

test('断流所需的调用全部放行', () => {
  const allowed = [
    ['GET', `${A}/workers/scripts`],
    ['GET', `${A}/workers/scripts/app/schedules`],
    ['PUT', `${A}/workers/scripts/app/schedules`],
    ['GET', '/zones?account.id=acct&page=1&per_page=50'],
    ['GET', '/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint'],
    ['PUT', '/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint'],
    ['POST', '/zones/z1/rulesets/rs1/rules'],
    ['PATCH', '/zones/z1/rulesets/rs1/rules/rule1'],
    ['GET', `${A}/r2/buckets`],
    ['GET', `${bucket}/domains/managed`],
    ['PUT', `${bucket}/domains/managed`],
    ['GET', `${bucket}/domains/custom`],
    ['PUT', `${bucket}/domains/custom/files.example.test`],
  ];
  for (const [method, path] of allowed) {
    assert.equal(assertAllowed(method, path), true, `${method} ${path}`);
  }
});

test('方法与路径必须同时匹配', () => {
  // 路径在册但方法不在册
  assert.throws(() => assertAllowed('POST', `${A}/workers/scripts/app/schedules`), BlockedCallError);
  assert.throws(() => assertAllowed('PATCH', `${bucket}/domains/managed`), BlockedCallError);
});

test('小写方法名照样被规范化处理', () => {
  assert.equal(assertAllowed('get', `${A}/r2/buckets`), true);
  assert.throws(() => assertAllowed('delete', `${A}/r2/buckets`), BlockedCallError);
});

test('路径前缀相同但越界的不被放行', () => {
  assert.throws(() => assertAllowed('GET', `${A}/workers/scripts/app/schedules/extra`), BlockedCallError);
  assert.throws(() => assertAllowed('PUT', `${bucket}/domains/managed/sub`), BlockedCallError);
});

test('缺省参数不会绕过闸门', () => {
  assert.throws(() => assertAllowed(undefined, undefined), BlockedCallError);
  assert.throws(() => assertAllowed('GET', ''), BlockedCallError);
});
