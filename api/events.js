const ical = require('node-ical');
const COLOR_MAP = {'11':'hula','4':'hula','5':'tahitian','7':'workshop','10':'music','9':'yoga','8':'special','1':'special'};
const TYPE_FROM_TITLE=(t)=>{const s=t.toLowerCase();if(s.includes('tahitian')||s.includes('タヒチ'))return'tahitian';if(s.includes('hula')||s.includes('フラ'))return'hula';if(s.includes('yoga')||s.includes('ヨガ'))return'yoga';if(s.includes('workshop')||s.includes('ワークショップ'))return'workshop';if(s.includes('live')||s.includes('music')||s.includes('ライブ')||s.includes('ミュージック'))return'music';if(s.includes('close')||s.includes('貸切')||s.includes('定休'))return'closed';return'special';};
function toJST(d){if(!d)return null;return new Date(new Date(d).getTime()+9*3600000);}
function fmtDate(d){return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');}
function fmtTime(d){return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');}
function expandRec(ev,s,e){const res=[];try{const R=require('rrule');const RR=R.RRule||(R.default&&R.default.RRule)||R;const ds=toJST(ev.start);const dur=ev.end?new Date(ev.end)-new Date(ev.start):3600000;let rs='';if(ev.rrule&&ev.rrule.toString)rs=ev.rrule.toString();else if(typeof ev.rrule==='string')rs=ev.rrule;if(!rs)return res;const rule=RR.fromString(rs.includes('DTSTART')?rs:'DTSTART:'+ds.toISOString().replace(/[-:]/g,'').replace('.000Z','Z')+'\n'+rs);const exs=(ev.exdate?Object.values(ev.exdate):[]).map(x=>fmtDate(toJST(x instanceof Date?x:x.val)));for(const d of rule.between(s,e,true)){const o=toJST(d);const dt=fmtDate(o);if(exs.includes(dt))continue;const cs=new Date(Date.UTC(o.getUTCFullYear(),o.getUTCMonth(),o.getUTCDate(),ds.getUTCHours(),ds.getUTCMinutes()));res.push({date:dt,startTime:fmtTime(cs),endTime:ev.end?fmtTime(new Date(+cs+dur)):null,isRecurring:true});}}catch(err){console.error(err.message);}return res;}
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','s-maxage=60,stale-while-revalidate=60');
  res.setHeader('Access-Control-Allow-Origin','*');
  const url=process.env.GCAL_ICAL_URL;
  if(!url)return res.status(500).json({error:'GCAL_ICAL_URL not set'});
  try{
    const data=await require('node-ical').async.fromURL(url);
    const now=new Date(),s=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)),e=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+3,0));
    const evs=[];
    for(const k of Object.keys(data)){
      const ev=data[k];if(ev.type!=='VEVENT')continue;
      const t=ev.summary||'';
      const type=COLOR_MAP[ev.color||ev['x-apple-calendar-color']||'']||TYPE_FROM_TITLE(t);
      const base={id:ev.uid||k,title:t.trim(),description:ev.description||'',type,featured:t.includes('周年'),location:ev.location||''};
      if(ev.rrule){for(const o of expandRec(ev,s,e))evs.push(Object.assign({},base,o,{isRecurring:true}));}
      else{const js=toJST(ev.start);if(!js)continue;const dt=fmtDate(js);if(new Date(dt)<s||new Date(dt)>e)continue;evs.push(Object.assign({},base,{date:dt,startTime:fmtTime(js),endTime:ev.end?fmtTime(toJST(ev.end)):null,isRecurring:false}));}
    }
    evs.sort((a,b)=>a.date!==b.date?a.date.localeCompare(b.date):(a.startTime||'').localeCompare(b.startTime||''));
    const merged=[];
    for(const ev of evs){
      const ex=merged.find(m=>m.date===ev.date&&m.title===ev.title&&m.type===ev.type);
      if(ex){if(!ex.times)ex.times=[ex.startTime];if(ev.startTime&&!ex.times.includes(ev.startTime))ex.times.push(ev.startTime);}
      else merged.push(Object.assign({},ev,{times:ev.startTime?[ev.startTime]:[]}));
    }
    res.status(200).json({events:merged,fetchedAt:new Date().toISOString(),count:merged.length});
  }catch(err){res.status(500).json({error:err.message});}
};
