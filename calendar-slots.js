function parisParts(date=new Date()){
  const parts=new Intl.DateTimeFormat("fr-FR",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=name=>Number(parts.find(p=>p.type===name)?.value||0);
  return {year:get("year"),month:get("month"),day:get("day")};
}
function parisOffsetMinutes(date){
  const part=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",timeZoneName:"shortOffset",hour:"2-digit"}).formatToParts(date).find(p=>p.type==="timeZoneName");
  const m=String(part?.value||"GMT+1").match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if(!m) return 60;
  return (m[1]==="-"?-1:1)*(Number(m[2])*60+Number(m[3]||0));
}
function parisDateAt(daysFromToday,hour){
  const p=parisParts();
  const guess=Date.UTC(p.year,p.month-1,p.day+daysFromToday,hour,0,0);
  const first=new Date(guess);
  const offset=parisOffsetMinutes(first);
  return new Date(guess-offset*60000);
}
function availableSlotList(booked=[],busy=[]){
  const out=[], set=new Set(booked);
  for(let d=1;d<=21;d++){
    const day=parisDateAt(d,9);
    const weekday=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",weekday:"short"}).format(day);
    const dow=({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6})[weekday];
    if(dow===0) continue;
    const endHour=dow===6?13:18;
    for(let h=9;h<endHour;h++){
      const dt=parisDateAt(d,h);
      const end=new Date(dt.getTime()+60*60*1000);
      if(dt.getTime()<=Date.now()) continue;
      const locallyBooked=set.has(dt.getTime());
      const calendarBusy=busy.some(b=>{
        const bs=new Date(b.start).getTime(), be=new Date(b.end).getTime();
        return Number.isFinite(bs)&&Number.isFinite(be)&&bs<end.getTime()&&be>dt.getTime();
      });
      if(!locallyBooked&&!calendarBusy) out.push(dt.toISOString());
    }
  }
  return out;
}

module.exports = { parisDateAt, availableSlotList };
