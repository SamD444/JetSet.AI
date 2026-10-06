export interface ItineraryDayItem {
  day: number;
  title: string;
  activities: string[];
}

export function parseYMD(str: string): { year: number; month: number; day: number } | null {
  if (!str) return null;
  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return { year: parseInt(match[1], 10), month: parseInt(match[2], 10), day: parseInt(match[3], 10) };
  }
  return null;
}

export function getUtcDate(ymd: string): Date {
  const parsed = parseYMD(ymd);
  if (parsed) {
    return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0));
  }
  const d = new Date(ymd);
  if (!isNaN(d.getTime())) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  }
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
}

export function calculateCalendarDays(fromDate: string, toDate: string): number {
  if (!fromDate || !toDate) return 7;
  const start = getUtcDate(fromDate);
  const end = getUtcDate(toDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 7;
  const diffMs = end.getTime() - start.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

export function getDateForDay(fromDate: string, dayNum: number): string {
  const start = getUtcDate(fromDate);
  const target = new Date(start.getTime() + (dayNum - 1) * 24 * 60 * 60 * 1000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDayDateDisplay(ymd: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parsed = parseYMD(ymd);
  if (parsed) {
    return `${MONTHS[parsed.month - 1]} ${parsed.day}`;
  }
  return ymd;
}

export function findTargetDayFromInstruction(instruction: string, fromDate: string, toDate: string): number | null {
  if (!instruction) return null;
  const lower = instruction.toLowerCase();

  // 1. Explicit "Day X" mention
  const dayMatch = lower.match(/\bday\s*(\d+)\b/);
  if (dayMatch) {
    const num = parseInt(dayMatch[1], 10);
    if (!isNaN(num) && num >= 1) return num;
  }

  // 2. Date mentions like "Dec 31", "December 31", "31st Dec", "Jan 1", "January 1st", "1 Jan", "2026-12-31"
  const totalDays = calculateCalendarDays(fromDate, toDate);
  const MONTHS = [
    { name: 'january', short: 'jan', month: 1 },
    { name: 'february', short: 'feb', month: 2 },
    { name: 'march', short: 'mar', month: 3 },
    { name: 'april', short: 'apr', month: 4 },
    { name: 'may', short: 'may', month: 5 },
    { name: 'june', short: 'jun', month: 6 },
    { name: 'july', short: 'jul', month: 7 },
    { name: 'august', short: 'aug', month: 8 },
    { name: 'september', short: 'sep', month: 9 },
    { name: 'october', short: 'oct', month: 10 },
    { name: 'november', short: 'nov', month: 11 },
    { name: 'december', short: 'dec', month: 12 },
  ];

  for (let d = 1; d <= totalDays; d++) {
    const dateYmd = getDateForDay(fromDate, d);
    const parsed = parseYMD(dateYmd);
    if (!parsed) continue;

    // Check ISO format match
    if (lower.includes(dateYmd)) return d;

    // Check Month Day formats
    const mInfo = MONTHS[parsed.month - 1];
    const dayStr = String(parsed.day);
    const dayPadded = String(parsed.day).padStart(2, '0');
    const ordinals = ['th', 'st', 'nd', 'rd'];
    const ord = (parsed.day % 10 <= 3 && Math.floor((parsed.day % 100) / 10) !== 1) ? ordinals[parsed.day % 10] || 'th' : 'th';

    const patterns = [
      new RegExp(`\\b${mInfo.name}\\s+${dayStr}(?:${ord})?\\b`, 'i'),
      new RegExp(`\\b${mInfo.short}\\.?\\s+${dayStr}(?:${ord})?\\b`, 'i'),
      new RegExp(`\\b${dayStr}(?:${ord})?\\s+(?:of\\s+)?${mInfo.name}\\b`, 'i'),
      new RegExp(`\\b${dayStr}(?:${ord})?\\s+(?:of\\s+)?${mInfo.short}\\b`, 'i'),
      new RegExp(`\\b${mInfo.name}\\s+${dayPadded}\\b`, 'i'),
      new RegExp(`\\b${mInfo.short}\\.?\\s+${dayPadded}\\b`, 'i'),
    ];

    if (patterns.some(p => p.test(lower))) {
      return d;
    }
  }

  // Check special keywords
  if (lower.includes('new year\'s eve') || lower.includes('new year eve') || lower.includes('new years eve')) {
    for (let d = 1; d <= totalDays; d++) {
      const dateYmd = getDateForDay(fromDate, d);
      if (dateYmd.endsWith('-12-31')) return d;
    }
  }
  if (lower.includes('new year\'s day') || lower.includes('new year day') || lower.includes('new years day')) {
    for (let d = 1; d <= totalDays; d++) {
      const dateYmd = getDateForDay(fromDate, d);
      if (dateYmd.endsWith('-01-01')) return d;
    }
  }

  return null;
}

export function parseItineraryDays(text: string): ItineraryDayItem[] {
  if (!text) return [];
  const days: ItineraryDayItem[] = [];
  const dayRegex = /(?:^|\n)(?:#{1,4}\s*)?(?:\*{0,2})Day\s+(\d+)(?:[:\s–-]*)([^\n]*?)(?:\*{0,2})(?=\n|$)/gi;
  const matches = [...text.matchAll(dayRegex)];

  if (matches.length === 0) {
    return [];
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const dayNum = parseInt(match[1], 10);
    const title = match[2].replace(/[*#]/g, '').trim() || `Day ${dayNum}`;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const rawContent = text.slice(start, end).trim();

    const activities = rawContent
      .split('\n')
      .map(l => l.replace(/^[\s\-\*\d\.\•]+/, '').trim())
      .filter(l => l.length > 2);

    days.push({
      day: dayNum,
      title: title.replace(/^:\s*/, ''),
      activities: activities.length > 0 ? activities : ['Explore destination attractions and local culture.'],
    });
  }

  return days;
}

export function formatItinerary(days: ItineraryDayItem[]): string {
  return days
    .map(d => {
      const header = `Day ${d.day}: ${d.title}`;
      const acts = d.activities.map(a => `- ${a.startsWith('-') ? a.substring(1).trim() : a}`).join('\n');
      return `${header}\n${acts}`;
    })
    .join('\n\n');
}

export function validateItinerary(
  text: string,
  fromDate: string,
  toDate: string,
): { valid: boolean; errors: string[]; parsedDays: ItineraryDayItem[] } {
  const errors: string[] = [];
  const expectedDays = calculateCalendarDays(fromDate, toDate);
  const parsedDays = parseItineraryDays(text);

  if (parsedDays.length === 0) {
    errors.push('No Day sections found in itinerary text.');
    return { valid: false, errors, parsedDays: [] };
  }

  if (parsedDays.length !== expectedDays) {
    errors.push(`Day count mismatch: expected ${expectedDays} days for date range ${fromDate} to ${toDate}, but got ${parsedDays.length} days.`);
  }

  // Check sequential day numbers 1..N
  const dayNums = parsedDays.map(d => d.day);
  for (let i = 0; i < parsedDays.length; i++) {
    if (parsedDays[i].day !== i + 1) {
      errors.push(`Non-sequential day number: expected Day ${i + 1}, got Day ${parsedDays[i].day}.`);
      break;
    }
  }

  const uniqueNums = new Set(dayNums);
  if (uniqueNums.size !== parsedDays.length) {
    errors.push('Duplicate day numbers found in itinerary.');
  }

  return {
    valid: errors.length === 0,
    errors,
    parsedDays,
  };
}

export function generateDefaultItinerary(destination: string, fromDate: string, toDate: string): string {
  const totalDays = calculateCalendarDays(fromDate, toDate);
  const destName = destination || 'Destination';
  const days: ItineraryDayItem[] = [];

  const genericThemes = [
    { title: `Arrival & Neighborhood Exploration`, acts: [`Arrive in ${destName} and transfer to accommodation`, `Check-in, freshen up, and take an introductory walking tour of the local area`, `Welcome dinner at a popular authentic regional eatery`] },
    { title: `Iconic Landmarks & Historical Sights`, acts: [`Morning guided visit to primary landmark attractions`, `Lunch at a recommended local cafe or bistro`, `Afternoon museum and cultural heritage immersion`, `Scenic sunset viewpoint and leisurely dinner`] },
    { title: `Cultural Highlights & City Center`, acts: [`Explore renowned historic districts, architecture, and public squares`, `Visit vibrant local artisan markets and artisan shops`, `Evening stroll and relaxed dinner enjoying regional cuisine`] },
    { title: `Arts, Gardens & Scenic Views`, acts: [`Morning visit to prominent art galleries or botanical gardens`, `Lunch sampling street food or bistro delicacies`, `Afternoon panoramic viewpoint or scenic river/canal walk`, `Dinner at a highly rated local restaurant`] },
    { title: `Day Excursion & Regional Exploration`, acts: [`Take a scenic day trip or countryside excursion nearby`, `Explore picturesque neighboring villages, historic castles, or nature reserves`, `Traditional local lunch experience during excursion`, `Return to ${destName} for an evening at leisure`] },
    { title: `Local Neighborhoods & Culinary Delights`, acts: [`Discover bohemian neighborhoods and hidden alleyways`, `Guided food tour or visits to artisan bakeries and cafes`, `Relaxed afternoon in a central park or shopping district`, `Dinner featuring chef's tasting menu or regional specialties`] },
    { title: `Leisure, Wellness & Exploration`, acts: [`Relaxed morning at your own pace with a leisurely breakfast`, `Visit botanical grounds, spas, or scenic waterfront promenades`, `Afternoon boutique browsing or optional museum stop`, `Evening dinner and relaxed nightlife`] },
    { title: `Celebration & Special Experiences`, acts: [`Morning discovery of historic monuments and quiet courtyards`, `Lunch at a scenic outdoor cafe`, `Afternoon activities tailored to local festivities and attractions`, `Festive celebratory dinner with evening entertainment`] },
    { title: `Hidden Gems & Local Secrets`, acts: [`Off-the-beaten-path sightseeing of lesser-known treasures`, `Explore local craft markets and specialty shops`, `Relaxing afternoon tea or cafe break`, `Scenic evening walk and dinner`] },
    { title: `Nature, Parks & Coastal/River Trails`, acts: [`Morning hike or stroll through prominent natural parks or waterfront`, `Picnic lunch or cafe stop with panoramic views`, `Afternoon outdoor leisure or boat cruise`, `Casual dinner at a beloved neighborhood tavern`] },
  ];

  for (let i = 1; i <= totalDays; i++) {
    const isFirst = i === 1;
    const isLast = i === totalDays;
    const dateYmd = getDateForDay(fromDate, i);
    const dateDisplay = formatDayDateDisplay(dateYmd);

    if (isFirst) {
      days.push({
        day: 1,
        title: `Arrival & First Impressions`,
        activities: [
          `Arrive in ${destName} (${dateDisplay}) and transfer to accommodation`,
          `Check-in, settle in, and take a gentle stroll around the neighborhood`,
          `Welcome dinner savoring authentic local dishes`,
        ],
      });
    } else if (isLast) {
      days.push({
        day: i,
        title: `Departure & Farewell`,
        activities: [
          `Final breakfast and morning souvenir shopping in ${destName} (${dateDisplay})`,
          `Check-out and transfer to airport/station for departure`,
        ],
      });
    } else {
      const theme = genericThemes[(i - 2) % genericThemes.length];
      days.push({
        day: i,
        title: theme.title,
        activities: theme.acts,
      });
    }
  }

  return formatItinerary(days);
}

export function adaptItineraryForDates(
  existingItinerary: string,
  destination: string,
  oldFromDate: string,
  oldToDate: string,
  newFromDate: string,
  newToDate: string,
): string {
  const newTotalDays = calculateCalendarDays(newFromDate, newToDate);
  const destName = destination || 'Destination';

  let currentDays = parseItineraryDays(existingItinerary);
  if (currentDays.length === 0) {
    return generateDefaultItinerary(destination, newFromDate, newToDate);
  }

  const resultingDays: ItineraryDayItem[] = [];

  if (newTotalDays > currentDays.length) {
    // Extend itinerary
    for (let i = 0; i < currentDays.length; i++) {
      const d = currentDays[i];
      if (i === currentDays.length - 1 && /departure|farewell|wrap-up/i.test(d.title)) {
        // Change previous departure day into full activity day
        resultingDays.push({
          day: i + 1,
          title: `Regional Exploration & Highlights`,
          activities: [
            `Full-day exploration of ${destName}'s cultural sites and neighborhoods`,
            `Lunch at a traditional local bistro`,
            `Afternoon leisure and sightseeing`,
            `Dinner at a popular local eatery`,
          ],
        });
      } else {
        resultingDays.push({
          day: i + 1,
          title: d.title,
          activities: d.activities,
        });
      }
    }

    // Add intermediate days
    const extraThemes = [
      { title: `Hidden Gems & Local Culture`, acts: [`Morning exploration of charming historic quarters`, `Lunch at an authentic artisan market`, `Afternoon museum or gallery visit`, `Evening dining and relaxed stroll`] },
      { title: `Scenic Excursion & Nature Trails`, acts: [`Day trip to nearby scenic countryside or landmarks`, `Outdoor activities and picturesque photo opportunities`, `Local lunch at a village cafe`, `Return for evening dining in ${destName}`] },
      { title: `Leisure, Markets & Culinary Delights`, acts: [`Leisurely morning with cafe culture and shopping`, `Visit renowned regional markets and specialty boutiques`, `Afternoon garden or waterfront walk`, `Dinner featuring regional tasting menu`] },
    ];

    while (resultingDays.length < newTotalDays - 1) {
      const dayNum = resultingDays.length + 1;
      const theme = extraThemes[(dayNum - 1) % extraThemes.length];
      resultingDays.push({
        day: dayNum,
        title: theme.title,
        activities: theme.acts,
      });
    }

    // Final day: departure
    if (resultingDays.length < newTotalDays) {
      const dayNum = newTotalDays;
      const dateDisplay = formatDayDateDisplay(getDateForDay(newFromDate, dayNum));
      resultingDays.push({
        day: dayNum,
        title: `Departure & Farewell`,
        activities: [
          `Final breakfast and morning souvenir shopping in ${destName} (${dateDisplay})`,
          `Check-out and transfer to airport/station for departure`,
        ],
      });
    }
  } else if (newTotalDays < currentDays.length) {
    // Truncate itinerary
    for (let i = 0; i < newTotalDays - 1; i++) {
      resultingDays.push({
        day: i + 1,
        title: currentDays[i].title,
        activities: currentDays[i].activities,
      });
    }
    // Final day is departure
    const finalDayNum = newTotalDays;
    const dateDisplay = formatDayDateDisplay(getDateForDay(newFromDate, finalDayNum));
    resultingDays.push({
      day: finalDayNum,
      title: `Departure & Farewell`,
      activities: [
        `Final breakfast and souvenir shopping in ${destName} (${dateDisplay})`,
        `Check-out and transfer to airport/station for departure`,
      ],
    });
  } else {
    // Same number of days, ensure sequential 1..N day numbering
    for (let i = 0; i < currentDays.length; i++) {
      resultingDays.push({
        day: i + 1,
        title: currentDays[i].title,
        activities: currentDays[i].activities,
      });
    }
  }

  return formatItinerary(resultingDays);
}
