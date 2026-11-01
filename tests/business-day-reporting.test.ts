import {test} from 'node:test';
import assert from 'node:assert/strict';
import {businessWindow,windowsForDates,outsideWindows,customWindow,validateHours,versionForDate,transitionIssues} from '../src/lib/business-day';
import {zonedDateTime} from '../src/lib/date-range';
const hours={startTime:'08:00',endTime:'02:00',timezone:'Africa/Cairo',is24Hours:false,effectiveDate:'2026-10-24'};
test('overnight window includes opening and 01:30, excludes pre-opening and closing',()=>{
 const w=businessWindow('2026-10-24',hours);
 assert.equal(w.from.toISOString(),'2026-10-24T05:00:00.000Z');assert.equal(w.to.toISOString(),'2026-10-24T23:00:00.000Z');
 const inside=(local:string)=>{const at=zonedDateTime(local,'Africa/Cairo').at;return at>=w.from&&at<w.to;};
 assert.equal(inside('2026-10-25T01:30'),true);assert.equal(inside('2026-10-24T07:59'),false);assert.equal(inside('2026-10-24T08:00'),true);assert.equal(inside('2026-10-25T02:00'),false);
});
test('midnight closes the following date, daytime closes same date',()=>{
 assert.equal(businessWindow('2026-10-24',{...hours,startTime:'10:00',endTime:'00:00'}).endLocal,'2026-10-25T00:00');
 assert.equal(businessWindow('2026-10-24',{...hours,endTime:'18:00'}).endLocal,'2026-10-24T18:00');
});
test('equal hours require explicit 24-hour operation and a local day crosses DST safely',()=>{
 assert.throws(()=>validateHours({...hours,endTime:'08:00'}));
 const w=businessWindow('2026-10-29',{...hours,startTime:'08:00',endTime:'08:00',is24Hours:true});
 assert.equal(w.to.getTime()-w.from.getTime(),25*3600000);
 assert.throws(()=>validateHours({...hours,is24Hours:true}));
});
test('invalid calendar dates, timezones, times and custom ordering are rejected',()=>{
 for(const patch of [{startTime:'24:00'},{endTime:'1:00'},{timezone:'Egypt/Invalid'}])assert.throws(()=>validateHours({...hours,...patch}));
 assert.throws(()=>businessWindow('2026-02-30',hours));
 assert.throws(()=>customWindow('2026-10-24T10:00','2026-10-24T09:00','Africa/Cairo'));
});
test('immutable versions resolve history and multiple dates omit closed gaps',()=>{
 const versions=[hours,{...hours,startTime:'10:00',endTime:'18:00',effectiveDate:'2026-11-01'}];
 assert.equal(versionForDate('2026-10-23',versions).startTime,'00:00');
 assert.equal(versionForDate('2026-10-31',versions).startTime,'08:00');
 assert.equal(versionForDate('2026-11-01',versions).startTime,'10:00');
 const ws=windowsForDates('branch','2026-10-24','2026-10-25',versions);assert.equal(ws.length,2);assert.ok(ws[0].to<ws[1].from);
 assert.equal(ws.filter(w=>new Date('2026-10-25T02:00:00Z')>=w.from&&new Date('2026-10-25T02:00:00Z')<w.to).length,0);
});
test('outside hours cover closing through next opening, including an effective-date gap',()=>{
 const ws=outsideWindows('b','2026-10-24','2026-10-24',[hours]);assert.equal(ws.length,1);assert.equal(ws[0].startLocal,'2026-10-25T02:00');assert.equal(ws[0].endLocal,'2026-10-25T08:00');
 const issues=transitionIssues({...hours,effectiveDate:'2026-10-26'},[hours]);assert.ok(issues.some(i=>i.kind==='gap'));
 assert.ok(transitionIssues({...hours,startTime:'01:00',endTime:'23:00',effectiveDate:'2026-10-26'},[hours]).some(i=>i.kind==='overlap'));
});
test('different stores use different timezone windows without duplicate events',()=>{
 const a=windowsForDates('a','2026-10-24','2026-10-25',[hours]);const b=windowsForDates('b','2026-10-24','2026-10-25',[{...hours,startTime:'10:00',endTime:'18:00',timezone:'Asia/Dubai'}]);
 assert.notEqual(a[0].from.toISOString(),b[0].from.toISOString());
 const events=[{branch:'a',at:a[0].from},{branch:'a',at:a[1].from},{branch:'b',at:b[0].from}];
 assert.equal(events.filter(e=>[...a,...b].some(w=>w.branchId===e.branch&&e.at>=w.from&&e.at<w.to)).length,3);
});
test('Cairo DST gap and repeated New York hour resolve compatibly with warnings',()=>{
 const gap=zonedDateTime('2026-04-24T00:30','Africa/Cairo');assert.equal(gap.at.toISOString(),'2026-04-23T22:30:00.000Z');assert.ok(gap.warning);
 const fold=zonedDateTime('2026-11-01T01:30','America/New_York');assert.equal(fold.at.toISOString(),'2026-11-01T05:30:00.000Z');assert.ok(fold.warning);
 const w=businessWindow('2026-03-08',{...hours,startTime:'00:00',endTime:'00:00',is24Hours:true,timezone:'America/New_York'});assert.equal(w.to.getTime()-w.from.getTime(),23*3600000);
});
