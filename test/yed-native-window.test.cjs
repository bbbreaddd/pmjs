'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const native = process.env.PMJS_NATIVE_ADDON ? require(process.env.PMJS_NATIVE_ADDON) : null;
const compare = native?.plugins.yed.sameTileWindow;
function cells(data,width,height,x,y,columns,rows,wrapX,wrapY){
  const result=[];
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
    let cx=x+column,cy=y+row;
    if(wrapX)cx=((cx%width)+width)%width;
    if(wrapY)cy=((cy%height)+height)%height;
    result.push(cx<0||cy<0||cx>=width||cy>=height?0:data[cy*width+cx]||0);
  }
  return result;
}
test('native comparison matches live windows, sparse values and wrapping', { skip: !native }, () => {
  const object={},data=[1,0,NaN,undefined,false,'',null,true,'2',object,11,12];
  for(const wrapX of [false,true])for(const wrapY of [false,true])for(const [x,y]of[[-2,-1],[0,0],[3,2]]){
    const window=cells(data,4,3,x,y,6,5,wrapX,wrapY),snapshot=['prefix',...window,'tail'];
    assert.equal(compare(data,snapshot,4,3,x,y,6,5,1,wrapX,wrapY),true);
    snapshot[7]={};
    assert.equal(compare(data,snapshot,4,3,x,y,6,5,1,wrapX,wrapY),false);
  }
});
test('native comparison observes accessors once in row order and propagates exceptions', { skip: !native }, () => {
  const data=[],calls=[];
  for(let i=0;i<4;i++)Object.defineProperty(data,i,{get(){calls.push(i);return i+1;},configurable:true});
  assert.equal(compare(data,[1,2,3,4],2,2,0,0,2,2,0,false,false),true);
  assert.deepEqual(calls,[0,1,2,3]);
  Object.defineProperty(data,2,{get(){throw new Error('authored accessor');}});
  assert.throws(()=>compare(data,[1,2,3,4],2,2,0,0,2,2,0,false,false),/authored accessor/);
});
test('unsupported geometry requests ordinary JavaScript handling before reading cells', { skip: !native }, () => {
  let reads=0;const data=[];Object.defineProperty(data,0,{get(){reads++;return 1;}});
  assert.equal(compare(data,[1],1.5,1,0,0,1,1,0,false,false),null);
  assert.equal(compare(data,[1],1,1,0,0,1,1,5,false,false),null);
  assert.equal(compare({},[1],1,1,0,0,1,1,0,false,false),null);
  assert.equal(reads,0);
});

const read = native?.plugins.yed.readTileWindow;
test('native extraction reads current cells without taking ownership of source data', { skip: !native }, () => {
  const marker = {}, data = [1, , false, marker, NaN, '2'];
  for (const wrapX of [false, true]) for (const wrapY of [false, true]) {
    assert.deepEqual(read(data, 3, 2, -2, -1, 6, 4, wrapX, wrapY),
      cells(data, 3, 2, -2, -1, 6, 4, wrapX, wrapY));
  }
  const first = read(data, 3, 2, 0, 0, 3, 2, false, false);
  data[0] = 42;
  assert.equal(first[0], 1);
  assert.equal(read(data, 3, 2, 0, 0, 3, 2, false, false)[0], 42);
  assert.equal(first[3], marker);
  assert.deepEqual(read(data, 3, 2, 0, 0, 0, 0, false, false), []);
});
test('native extraction preserves getter order, exceptions and unsupported-input fallback', { skip: !native }, () => {
  const data = [], order = [];
  for (let i = 0; i < 4; i++) Object.defineProperty(data, i, {
    configurable: true, get() { order.push(i); return i + 1; }
  });
  assert.deepEqual(read(data, 2, 2, 0, 0, 2, 2, false, false), [1, 2, 3, 4]);
  assert.deepEqual(order, [0, 1, 2, 3]);
  order.length = 0;
  assert.equal(read(data, 2.5, 2, 0, 0, 2, 2, false, false), null);
  assert.equal(read(data, 2, 2, 0, 0, 1048576, 2, false, false), null);
  assert.deepEqual(order, []);
  const error = new Error('authored cell failure');
  Object.defineProperty(data, 2, { get() { throw error; } });
  assert.throws(() => read(data, 2, 2, 0, 0, 2, 2, false, false), e => e === error);
});
