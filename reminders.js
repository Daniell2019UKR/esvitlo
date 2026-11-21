import {dateInKyiv,currentSlot} from './public/dates.js';

export function dueOutage(snapshot, group, lead, now, restored=false) {
 const current = snapshot?.current ?? snapshot;
 if (!current || snapshot.error || snapshot.emergency?.active) return null;
 // A half-hour boundary in Kyiv also falls on a UTC half-hour boundary.
 const start = Math.floor((now.getTime() + lead * 60000) / 1800000) * 1800000;
 if (start <= now.getTime() || now.getTime() - (start - lead * 60000) >= 60000) return null;
 const at = new Date(start);
 const date = dateInKyiv(at);
 const slot = currentSlot(at);
 const before = new Date(start - 60000);
 const previousDate = dateInKyiv(before);
 const days = current.days ?? [];
 if (current.retainedDates?.includes(date)) return null;
 const slots = days.find(day => day.date === date)?.groups[group];
 const previous = slot > 0 ? slots?.[slot - 1] : current.retainedDates?.includes(previousDate) ? undefined :
  days.find(day => day.date === previousDate)?.groups[group]?.[47];
 if (slots?.[slot] !== restored || (restored ? previous !== false :
  previous !== true && !(slot === 0 && previous === undefined))) return null;
 return {start,date,time:`${String(Math.floor(slot/2)).padStart(2,'0')}:${slot%2?'30':'00'}`};
}
