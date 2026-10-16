import {describe,it,expect} from 'vitest';
import {collectionEvents} from '../../server/attendance/service-v2';

type Arguments = Parameters<typeof collectionEvents>;
const source = (record_key:string)=>({record_key,student_uid:'00000000-0000-4000-8000-000000000001',
  eligibility_json:[]}) as unknown as Arguments[2][number];
const incoming = (recordKey:string,mark:'X'|'J')=>({recordKey,date:'2026-10-16',slot:1,mark});
describe('frequency multi-origin baseline',()=>{
  it('compares each source to its own earlier mark, not a sibling origin',async()=>{
    const historical=[
      {record_key:'a',student_uid:source('a').student_uid,date:'2026-10-16',slot:1,mark:'X'},
      {record_key:'b',student_uid:source('b').student_uid,date:'2026-10-16',slot:1,mark:'J'}
    ];
    let sql='';
    const tx={query:async (query:string)=>{sql=query;return historical;}} as unknown as Arguments[0];
    const input={academicYear:2026,classId:1,requestId:'00000000-0000-4000-8000-000000000002',
      marks:[incoming('a','X'),incoming('b','J')],coverage:[]} as unknown as Arguments[1];
    const unchanged=await collectionEvents(tx,input,[source('b'),source('a')]);
    expect(unchanged).toHaveLength(2);
    expect(unchanged.every(e=>!e.changed)).toBe(true);
    expect(sql).toContain('DISTINCT ON(p.record_key,o.student_uid,o.date,o.slot)');
    expect(sql).toContain('p.record_key');
    input.marks=[incoming('a','J'),incoming('b','J')];
    const changed=await collectionEvents(tx,input,[source('a'),source('b')]);
    expect(changed.map(e=>({recordKey:e.recordKey,changed:e.changed}))).toEqual([
      {recordKey:'a',changed:true},{recordKey:'b',changed:false}]);
  });
});
