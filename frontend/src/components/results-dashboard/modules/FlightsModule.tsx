"use client";

import { getApiUrl } from '@/utils/api';
import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    ExternalLink, Search, Plane, CalendarDays,
    Loader2, RefreshCw, ChevronDown, ChevronUp, Clock, Leaf
} from "lucide-react";
import SkeletonLoader from "../SkeletonLoader";
import { ModuleProps } from "./types";
import { useUserCurrency } from "@/hooks/useUserCurrency";
import { FlightFilters, SortOption } from "@/components/flights/FlightFilters";
import { parseIsoDuration } from "@/utils/flight-utils";
import { formatSingleDisplayDate, parseYMD } from "@/lib/dateUtils";

// --- Types ---

interface FlightLegItem {
    legNum: number;
    from: string;
    fromIata: string;
    to: string;
    toIata: string;
    date: string;
    note?: string;
}

interface FlightLegsData {
    gateway: string;
    gatewayIata: string;
    outbound: FlightLegItem[];
    return: FlightLegItem[];
    groundSegments: string[];
}

interface LegState {
    isLoading: boolean;
    flights: any[];
    error: string | null;
}

type JourneyGroup = {
    direction: "outbound" | "return";
    origin: string;
    originIata: string;
    destination: string;
    destinationIata: string;
    date: string;
    legs: FlightLegItem[];
};

export interface CompleteSegment {
    from: string;
    fromIata: string;
    to: string;
    toIata: string;
    departureTime: string;
    arrivalTime: string;
    carrierCode: string;
    airlineName: string;
    flightNumber: string;
    durationMinutes: number;
    airplane?: string;
    travelClass?: string;
    legroom?: string;
    price?: number | null;
}

export interface CompleteLayover {
    airportIata: string;
    airportName: string;
    durationMinutes: number;
    overnight?: boolean;
}

export interface CompleteJourney {
    id: string;
    direction: "outbound" | "return";
    origin: string;
    originIata: string;
    destination: string;
    destinationIata: string;
    departureDate: string;
    departureTime: string;
    arrivalTime: string;
    totalDurationMinutes: number;
    totalPrice: number;
    currency: string;
    stopCount: number;
    connections: string[]; // Airport names/IATAs for via display
    primaryAirline: string;
    carrierCodes: string[];
    segments: CompleteSegment[];
    layovers: CompleteLayover[];
    bookingUrl: string;
    matchScore?: number;
    matchReason?: string;
    carbonDiff?: number | null;
}

// --- Common City Mappings for Clear Airport + City Display ---

const IATA_CITY_MAP: Record<string, string> = {
    "CCU": "Kolkata", "DEL": "Delhi", "BOM": "Mumbai", "BLR": "Bengaluru",
    "MAA": "Chennai", "HYD": "Hyderabad", "BBI": "Bhubaneswar", "COK": "Kochi",
    "AMD": "Ahmedabad", "GOI": "Goa", "GOX": "Goa (Mopa)", "JAI": "Jaipur",
    "FCO": "Rome", "CIA": "Rome (Ciampino)", "MXP": "Milan", "LIN": "Milan (Linate)",
    "VCE": "Venice", "AMS": "Amsterdam", "CDG": "Paris", "ORY": "Paris (Orly)",
    "LHR": "London (Heathrow)", "LGW": "London (Gatwick)", "STN": "London (Stansted)",
    "FRA": "Frankfurt", "MUC": "Munich", "BER": "Berlin", "ZRH": "Zurich",
    "VIE": "Vienna", "MAD": "Madrid", "BCN": "Barcelona", "LIS": "Lisbon",
    "ATH": "Athens", "IST": "Istanbul", "DXB": "Dubai", "AUH": "Abu Dhabi",
    "DOH": "Doha", "SIN": "Singapore", "BKK": "Bangkok", "DMK": "Bangkok (Don Mueang)",
    "KUL": "Kuala Lumpur", "HKG": "Hong Kong", "NRT": "Tokyo (Narita)", "HND": "Tokyo (Haneda)",
    "KIX": "Osaka", "ICN": "Seoul (Incheon)", "SYD": "Sydney", "MEL": "Melbourne",
    "ADD": "Addis Ababa", "CAI": "Cairo", "JFK": "New York (JFK)", "EWR": "New York (Newark)",
    "ORD": "Chicago", "SFO": "San Francisco", "LAX": "Los Angeles", "YVR": "Vancouver",
    "YYZ": "Toronto", "KTM": "Kathmandu", "CMB": "Colombo", "DAC": "Dhaka",
};

export function formatAirportCity(nameOrCity: string, iata: string): string {
    const code = (iata || "").toUpperCase();
    const city = IATA_CITY_MAP[code] || nameOrCity || code;
    return `${city} (${code})`;
}

// --- Helpers ---

const fmtDisplay = (iso: string): string => {
    return formatSingleDisplayDate(iso, "day-month");
};

function formatMins(mins: number): string {
    if (!mins || isNaN(mins) || mins <= 0) return "--";
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function formatTimeString(isoOrTime: string): string {
    if (!isoOrTime) return "--:--";
    if (isoOrTime.includes("T")) {
        const d = new Date(isoOrTime);
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
        }
    }
    const match = isoOrTime.match(/(\d{1,2}:\d{2})/);
    return match ? match[1] : isoOrTime;
}

const MAP_TO_AIRLINE: Record<string, string> = {
    "AI": "Air India", "6E": "IndiGo", "UK": "Vistara", "SG": "SpiceJet",
    "QP": "Akasa Air", "I5": "AIX Connect", "IX": "Air India Express",
    "AA": "American Airlines", "DL": "Delta Air Lines", "UA": "United Airlines",
    "BA": "British Airways", "EK": "Emirates", "QR": "Qatar Airways",
    "EY": "Etihad Airways", "SQ": "Singapore Airlines", "LH": "Lufthansa",
    "AF": "Air France", "JL": "Japan Airlines", "NH": "ANA",
    "CX": "Cathay Pacific", "AC": "Air Canada", "QF": "Qantas",
    "VS": "Virgin Atlantic", "TK": "Turkish Airlines", "KL": "KLM",
    "FZ": "flydubai", "MH": "Malaysia Airlines", "TG": "Thai Airways",
    "ET": "Ethiopian Airlines", "WY": "Oman Air", "GF": "Gulf Air",
};

const AIRLINE_LOGO_URL = (code: string) =>
    `https://www.gstatic.com/flights/airline_logos/70px/${code}.png`;

// --- Normalization: Convert raw flights into Complete Journey objects ---

function normalizeSingleFlightToJourney(
    flight: any,
    idx: number,
    group: JourneyGroup,
    currencyOverride?: string
): CompleteJourney {
    const itinerary = flight.itineraries?.[0];
    const rawSegments = itinerary?.segments || [];
    const rawLayovers = itinerary?.layovers || [];

    const segments: CompleteSegment[] = rawSegments.map((s: any) => {
        const carrier = s.carrierCode || "AI";
        const fromIata = s.departure?.iataCode || group.originIata;
        const toIata = s.arrival?.iataCode || group.destinationIata;
        return {
            from: IATA_CITY_MAP[fromIata] || s.departure?.name || group.origin,
            fromIata,
            to: IATA_CITY_MAP[toIata] || s.arrival?.name || group.destination,
            toIata,
            departureTime: formatTimeString(s.departure?.at),
            arrivalTime: formatTimeString(s.arrival?.at),
            carrierCode: carrier,
            airlineName: s.airlineName || MAP_TO_AIRLINE[carrier] || `${carrier} Airlines`,
            flightNumber: s.flightNumber || "",
            durationMinutes: s.duration ? (typeof s.duration === "number" ? s.duration : parseIsoDuration(s.duration)) : 0,
            airplane: s.airplane,
            travelClass: s.travelClass,
            legroom: s.legroom,
            price: null,
        };
    });

    const layovers: CompleteLayover[] = rawLayovers.map((l: any) => {
        const airportIata = l.id || "";
        return {
            airportIata,
            airportName: IATA_CITY_MAP[airportIata] || l.name || airportIata || "Layover",
            durationMinutes: typeof l.duration === "number" ? l.duration : parseIsoDuration(l.duration || ""),
            overnight: l.overnight,
        };
    });

    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];

    const depTime = firstSeg ? firstSeg.departureTime : "--:--";
    const arrTime = lastSeg ? lastSeg.arrivalTime : "--:--";

    let durationMins = 0;
    if (itinerary?.duration) {
        durationMins = parseIsoDuration(itinerary.duration);
    } else {
        const segSum = segments.reduce((sum, s) => sum + s.durationMinutes, 0);
        const laySum = layovers.reduce((sum, l) => sum + l.durationMinutes, 0);
        durationMins = segSum + laySum;
    }

    const priceVal = parseFloat(flight.price?.total || "0");
    const currency = currencyOverride || flight.price?.currency || flight.price?.curr || "USD";

    // Stop count = segments.length - 1
    const stopCount = Math.max(0, segments.length - 1);

    // Intermediate connection airports
    const connections: string[] = [];
    if (segments.length > 1) {
        for (let i = 0; i < segments.length - 1; i++) {
            const arrCode = segments[i].toIata;
            const arrCity = IATA_CITY_MAP[arrCode] || segments[i].to || arrCode;
            connections.push(arrCity);
        }
    }

    const carrierCodes = Array.from(new Set(segments.map(s => s.carrierCode).filter(Boolean)));
    const primaryAirline = flight.airlineName || firstSeg?.airlineName || (carrierCodes[0] ? MAP_TO_AIRLINE[carrierCodes[0]] : "Airline");

    const bookingUrl = flight.googleFlightsUrl ||
        `https://www.google.com/travel/flights/search?q=Flights+from+${group.originIata}+to+${group.destinationIata}+on+${group.date}`;

    return {
        id: flight.id || `journey-${group.direction}-${idx}`,
        direction: group.direction,
        origin: group.origin,
        originIata: group.originIata,
        destination: group.destination,
        destinationIata: group.destinationIata,
        departureDate: group.date,
        departureTime: depTime,
        arrivalTime: arrTime,
        totalDurationMinutes: durationMins,
        totalPrice: isNaN(priceVal) ? 0 : priceVal,
        currency,
        stopCount,
        connections,
        primaryAirline,
        carrierCodes,
        segments,
        layovers,
        bookingUrl,
        matchScore: flight.matchScore,
        matchReason: flight.matchReason,
        carbonDiff: flight.carbonEmissions?.difference_percent,
    };
}

function combineMultiLegFlights(
    group: JourneyGroup,
    legStates: Record<string, LegState>,
    currencyOverride?: string
): CompleteJourney[] {
    const legs = group.legs;
    if (legs.length === 0) return [];

    if (legs.length === 1) {
        const leg = legs[0];
        const key = `${leg.legNum}#${leg.fromIata}#${leg.toIata}#${leg.date}`;
        const state = legStates[key];
        if (!state || !state.flights || state.flights.length === 0) return [];
        return state.flights.map((f, i) => normalizeSingleFlightToJourney(f, i, group, currencyOverride));
    }

    // Multi-leg combination (e.g. CCU -> DEL + DEL -> FCO)
    const legFlightLists: any[][] = [];
    for (const leg of legs) {
        const key = `${leg.legNum}#${leg.fromIata}#${leg.toIata}#${leg.date}`;
        const state = legStates[key];
        if (!state || !state.flights || state.flights.length === 0) {
            return []; // Waiting for all legs to resolve
        }
        legFlightLists.push(state.flights);
    }

    const combined: CompleteJourney[] = [];
    const list1 = legFlightLists[0];
    const list2 = legFlightLists[1];

    const maxCombinations = 15;
    let count = 0;

    for (let i = 0; i < Math.min(list1.length, 5); i++) {
        for (let j = 0; j < Math.min(list2.length, 4); j++) {
            if (count >= maxCombinations) break;
            const f1 = list1[i];
            const f2 = list2[j];

            const j1 = normalizeSingleFlightToJourney(f1, i, { ...group, destinationIata: legs[0].toIata, destination: legs[0].to }, currencyOverride);
            const j2 = normalizeSingleFlightToJourney(f2, j, { ...group, originIata: legs[1].fromIata, origin: legs[1].from }, currencyOverride);

            const allSegments = [...j1.segments, ...j2.segments];
            const transferAirportIata = legs[0].toIata;
            const transferCity = IATA_CITY_MAP[transferAirportIata] || legs[0].to || transferAirportIata;

            // Layover between leg1 and leg2
            const transferLayover: CompleteLayover = {
                airportIata: transferAirportIata,
                airportName: transferCity,
                durationMinutes: 120, // Default 2h connection
            };

            const allLayovers = [...j1.layovers, transferLayover, ...j2.layovers];
            const totalPrice = (j1.totalPrice || 0) + (j2.totalPrice || 0);
            const totalDurationMinutes = (j1.totalDurationMinutes || 0) + 120 + (j2.totalDurationMinutes || 0);

            // Total stop count is all intermediate segments
            const stopCount = allSegments.length - 1;
            const connections = [transferCity, ...j1.connections, ...j2.connections].filter(
                (v, idx, arr) => arr.indexOf(v) === idx && v !== group.origin && v !== group.destination
            );

            const carrierCodes = Array.from(new Set([...j1.carrierCodes, ...j2.carrierCodes]));
            const primaryAirline = j1.primaryAirline === j2.primaryAirline
                ? j1.primaryAirline
                : `${j1.primaryAirline} / ${j2.primaryAirline}`;

            const avgScore = Math.round(((j1.matchScore || 85) + (j2.matchScore || 85)) / 2);
            const bookingUrl = `https://www.google.com/travel/flights/search?q=Flights+from+${group.originIata}+to+${group.destinationIata}+on+${group.date}`;

            combined.push({
                id: `combined-${group.direction}-${i}-${j}`,
                direction: group.direction,
                origin: group.origin,
                originIata: group.originIata,
                destination: group.destination,
                destinationIata: group.destinationIata,
                departureDate: group.date,
                departureTime: j1.departureTime,
                arrivalTime: j2.arrivalTime,
                totalDurationMinutes,
                totalPrice,
                currency: j1.currency || currencyOverride || "USD",
                stopCount,
                connections,
                primaryAirline,
                carrierCodes,
                segments: allSegments,
                layovers: allLayovers,
                bookingUrl,
                matchScore: avgScore,
                matchReason: j1.matchReason || `Connecting route via ${transferCity}`,
            });
            count++;
        }
    }

    return combined;
}

// --- Booking Links Component ---

function DirectBookingLinks({ orgCode, destCode, travelDate }: { orgCode: string; destCode: string; travelDate: string }) {
    let y: string, m: string, d: string;
    const p = parseYMD(travelDate);
    if (p) {
        y = String(p.year);
        m = String(p.month).padStart(2, "0");
        d = String(p.day).padStart(2, "0");
    } else {
        const today = new Date();
        const fallback = new Date(today.getTime() + 7 * 86400000);
        y = String(fallback.getFullYear());
        m = String(fallback.getMonth() + 1).padStart(2, "0");
        d = String(fallback.getDate()).padStart(2, "0");
    }

    const links = [
        { name: "MakeMyTrip", url: `https://www.makemytrip.com/flight/search?itinerary=${orgCode}-${destCode}-${d}/${m}/${y}&tripType=O&paxType=A-1_C-0_I-0&intl=true&cabinClass=E` },
        { name: "Ixigo",      url: `https://www.ixigo.com/search/result/flight?from=${orgCode}&to=${destCode}&date=${y}-${m}-${d}&adults=1&children=0&infants=0&class=e` },
        { name: "Goibibo",    url: `https://www.goibibo.com/flights/air-${orgCode}-${destCode}-${y}${m}${d}--1-0-0-E-D/` },
    ];

    return (
        <div className="flex flex-wrap gap-2 mt-2 justify-center">
            {links.map(l => (
                <a key={l.name} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20 hover:bg-white/10 transition-all text-xs font-semibold">
                    <ExternalLink className="w-3 h-3" />
                    {l.name}
                </a>
            ))}
        </div>
    );
}

// --- Complete Journey Card Component ---

function CompleteJourneyCard({
    journey,
    isReturn,
    isTopRecommended,
}: {
    journey: CompleteJourney;
    isReturn: boolean;
    isTopRecommended: boolean;
}) {
    const [showDetails, setShowDetails] = useState(false);

    const accentText   = isReturn ? "text-purple-300" : "text-sky-300";
    const accentBg     = isReturn ? "bg-purple-500/10" : "bg-sky-500/10";
    const accentBorder = isReturn ? "border-purple-500/20" : "border-sky-500/20";
    
    // AI Recommendation: check explicit score or top recommendation under BEST
    const isRecommended = isTopRecommended || (journey.matchScore !== undefined && journey.matchScore >= 90);

    const stopLabel = journey.stopCount === 0
        ? "Nonstop"
        : `${journey.stopCount} stop${journey.stopCount > 1 ? "s" : ""}${journey.connections.length > 0 ? ` · via ${journey.connections.join(", ")}` : ""}`;

    const handleBook = () => {
        window.open(journey.bookingUrl, "_blank", "noopener,noreferrer");
    };

    return (
        <div className={`relative glass-panel rounded-2xl overflow-hidden border transition-all duration-300 ${
            isRecommended
                ? isReturn
                    ? "border-purple-500/40 shadow-[0_0_20px_rgba(168,85,247,0.15)] bg-purple-500/5 pt-7"
                    : "border-sky-500/40 shadow-[0_0_20px_rgba(14,165,233,0.15)] bg-sky-500/5 pt-7"
                : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]"
        } p-5 space-y-4`}>
            
            {/* ── AI Recommended Top Banner ── */}
            {isRecommended && (
                <div className={`absolute top-0 left-0 ${
                    isReturn
                        ? "bg-gradient-to-r from-purple-500 to-indigo-500"
                        : "bg-gradient-to-r from-sky-500 to-indigo-500"
                } text-white text-[10px] uppercase font-bold tracking-wider px-3.5 py-1 rounded-br-xl shadow-md z-10`}>
                    AI Recommended
                </div>
            )}

            {/* ── Top Header: Badges & Airline ── */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5">
                    {/* Airline logo */}
                    {journey.carrierCodes.length > 0 && (
                        <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center border border-white/20 overflow-hidden shadow-sm shrink-0">
                            <img
                                src={AIRLINE_LOGO_URL(journey.carrierCodes[0])}
                                alt={journey.primaryAirline}
                                className="w-5 h-5 object-contain"
                                onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = "none";
                                    (e.target as HTMLImageElement).parentElement!.innerHTML =
                                        `<span class="text-[10px] font-bold text-slate-700">${journey.carrierCodes[0]}</span>`;
                                }}
                            />
                        </div>
                    )}
                    <div>
                        <h4 className="font-semibold text-sm text-white leading-tight">{journey.primaryAirline}</h4>
                        <p className="text-[11px] text-white/50">{journey.direction === "return" ? "Return Flight" : "Outbound Flight"} · {fmtDisplay(journey.departureDate)}</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {(journey.matchReason || journey.matchScore) && (
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono shadow-sm">
                            AI {journey.matchScore || 95}% Match
                        </span>
                    )}
                </div>
            </div>

            {/* ── Main Route Visual / Timeline (The Complete Journey) ── */}
            <div className="flex items-center justify-between gap-2 sm:gap-4 py-3 px-4 rounded-xl bg-white/[0.03] border border-white/5">
                {/* Origin */}
                <div className="text-left shrink-0 min-w-[85px]">
                    <p className={`text-lg sm:text-xl font-bold font-mono ${accentText}`}>
                        {journey.departureTime}
                    </p>
                    <p className="text-xs font-semibold text-white/90">{formatAirportCity(journey.origin, journey.originIata)}</p>
                </div>

                {/* Visual Route Line */}
                <div className="flex flex-col items-center flex-1 px-2 min-w-0">
                    <p className="text-[11px] text-white/60 font-medium truncate mb-1">
                        {formatMins(journey.totalDurationMinutes)}
                    </p>
                    <div className="w-full h-[2px] bg-gradient-to-r from-transparent via-white/20 to-transparent relative flex items-center justify-center">
                        <div className={`w-6 h-6 rounded-full ${accentBg} border ${accentBorder} flex items-center justify-center shadow-sm`}>
                            <Plane className={`w-3 h-3 ${isReturn ? "text-purple-400 -rotate-45" : "text-sky-400 rotate-45"}`} />
                        </div>
                    </div>
                    <p className="text-[11px] text-white/70 font-medium mt-1 text-center truncate">
                        {stopLabel}
                    </p>
                </div>

                {/* Destination */}
                <div className="text-right shrink-0 min-w-[85px]">
                    <p className={`text-lg sm:text-xl font-bold font-mono ${accentText}`}>
                        {journey.arrivalTime}
                    </p>
                    <p className="text-xs font-semibold text-white/90">{formatAirportCity(journey.destination, journey.destinationIata)}</p>
                </div>
            </div>

            {/* AI Match Reason (if present) */}
            {journey.matchReason && (
                <div className="px-3 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/15 text-[11px] text-emerald-300/90 italic flex items-center gap-1.5">
                    <span className="font-semibold not-italic">AI Insight:</span> {journey.matchReason}
                </div>
            )}

            {/* ── Bottom Price & Actions Row ── */}
            <div className="flex items-center justify-between gap-4 pt-2 border-t border-white/10 flex-wrap">
                <div>
                    <span className="text-[10px] uppercase font-bold text-white/40 tracking-wider">
                        Total Journey Price ({journey.direction === "return" ? "Return" : "Outbound"})
                    </span>
                    <div className="flex items-baseline gap-1 mt-0.5">
                        <span className="text-xs font-bold text-white/70">{journey.currency}</span>
                        <span className="text-2xl font-extrabold text-white">
                            {journey.totalPrice > 0 ? journey.totalPrice.toLocaleString() : "Check Live"}
                        </span>
                    </div>
                    {journey.carbonDiff !== undefined && journey.carbonDiff !== null && (
                        <div className="flex items-center gap-1 text-[10px] text-emerald-400 mt-0.5">
                            <Leaf className="w-2.5 h-2.5" />
                            <span>{journey.carbonDiff > 0 ? `+${journey.carbonDiff}%` : `${journey.carbonDiff}%`} CO₂</span>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2 ml-auto">
                    {journey.segments.length > 0 && (
                        <button
                            onClick={() => setShowDetails(!showDetails)}
                            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white text-xs font-semibold transition-all cursor-pointer"
                        >
                            {showDetails ? "Hide details" : "View flight details"}
                            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                    )}

                    <button
                        onClick={handleBook}
                        className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-semibold text-xs text-white shadow-md transition-all cursor-pointer ${
                            isReturn
                                ? "bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700"
                                : "bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-600 hover:to-indigo-700"
                        }`}
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Book
                    </button>
                </div>
            </div>

            {/* ── Expandable Segment Breakdown (Secondary Info with Full City Names) ── */}
            <AnimatePresence>
                {showDetails && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden pt-3 border-t border-white/10 space-y-3"
                    >
                        <p className="text-xs font-bold text-white/80 uppercase tracking-wider">Flight Breakdown</p>

                        <div className="space-y-3">
                            {journey.segments.map((seg, sIdx) => (
                                <React.Fragment key={sIdx}>
                                    <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/5 space-y-2.5">
                                        <div className="flex items-center justify-between text-xs">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${accentBg} ${accentText}`}>
                                                    {sIdx + 1}
                                                </span>
                                                <span className="font-bold text-white">Segment {sIdx + 1}: {seg.airlineName}</span>
                                                {seg.flightNumber && <span className="font-mono text-white/40 text-[11px]">· {seg.flightNumber}</span>}
                                            </div>
                                            <span className="text-white/60 text-xs font-medium">{formatMins(seg.durationMinutes)}</span>
                                        </div>

                                        {/* Full City + Airport Name Timeline */}
                                        <div className="flex items-center justify-between text-xs px-2 py-1 bg-white/[0.02] rounded-lg">
                                            <div className="text-left">
                                                <p className="font-bold text-white">{seg.departureTime}</p>
                                                <p className="text-[11px] text-white/70">{formatAirportCity(seg.from, seg.fromIata)}</p>
                                            </div>
                                            <div className="flex flex-col items-center px-2">
                                                <span className="text-[10px] text-white/40 mb-0.5">{formatMins(seg.durationMinutes)}</span>
                                                <Plane className="w-3.5 h-3.5 text-white/30" />
                                            </div>
                                            <div className="text-right">
                                                <p className="font-bold text-white">{seg.arrivalTime}</p>
                                                <p className="text-[11px] text-white/70">{formatAirportCity(seg.to, seg.toIata)}</p>
                                            </div>
                                        </div>

                                        {(seg.airplane || seg.travelClass) && (
                                            <div className="flex items-center gap-2 text-[10px] text-white/40 pt-0.5">
                                                {seg.airplane && <span>{seg.airplane}</span>}
                                                {seg.airplane && seg.travelClass && <span>·</span>}
                                                {seg.travelClass && <span>{seg.travelClass}</span>}
                                            </div>
                                        )}

                                        {/* Segment Price Information */}
                                        <div className="flex items-center justify-between text-[11px] text-white/50 pt-1 border-t border-white/5">
                                            <span>Segment fare:</span>
                                            <span className="text-white/70 font-medium">
                                                {seg.price ? `${journey.currency} ${seg.price.toLocaleString()}` : "Included in total journey price"}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Layover banner if not the last segment */}
                                    {journey.layovers[sIdx] && (
                                        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                                            <div className="flex items-center gap-2">
                                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                                <span>Connection at <strong>{formatAirportCity(journey.layovers[sIdx].airportName, journey.layovers[sIdx].airportIata)}</strong></span>
                                            </div>
                                            <span className="font-semibold">{formatMins(journey.layovers[sIdx].durationMinutes)} transfer</span>
                                        </div>
                                    )}
                                </React.Fragment>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// --- FlightsModule Main Component ---

export default function FlightsModule({ tripId, org, dest, dates, curr }: ModuleProps) {
    const localeCurrency = useUserCurrency();
    const finalCurrency  = curr || localeCurrency;
    const API = getApiUrl();

    const [legsData,    setLegsData]    = useState<FlightLegsData | null>(null);
    const [legsStatus,  setLegsStatus]  = useState<"idle" | "loading" | "pending" | "ready" | "error">("idle");
    const [legStates,   setLegStates]   = useState<Record<string, LegState>>({});
    const fetchedKeys   = useRef<Set<string>>(new Set());
    const pollTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollCountRef  = useRef(0);
    const MAX_POLL = 15;

    // Outbound vs Return Journey Switcher (defaults to outbound)
    const [selectedDirection, setSelectedDirection] = useState<"outbound" | "return">("outbound");

    const [sortBy,   setSortBy]   = useState<SortOption>("BEST");
    const [maxStops, setMaxStops] = useState<number | null>(null);

    // Fetch flight legs from backend
    const fetchLegs = useCallback(async () => {
        if (!tripId) return;
        setLegsStatus("loading");
        try {
            const res = await fetch(API + "/trips/" + tripId + "/flight-legs");
            if (!res.ok) throw new Error("endpoint error");
            const data = await res.json();
            if (data.status === "pending") { setLegsStatus("pending"); return; }
            setLegsData(data.legs);
            setLegsStatus("ready");
            fetchedKeys.current.clear();
        } catch {
            setLegsStatus("error");
        }
    }, [tripId, API]);

    useEffect(() => { if (tripId) fetchLegs(); }, [tripId, fetchLegs]);

    // Poll while plan is generating
    useEffect(() => {
        if (legsStatus !== "pending") {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            pollCountRef.current = 0;
            return;
        }
        if (pollCountRef.current >= MAX_POLL) { setLegsStatus("error"); return; }
        pollTimerRef.current = setTimeout(async () => { pollCountRef.current++; await fetchLegs(); }, 3000);
        return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
    }, [legsStatus, fetchLegs]);

    // Fetch flights for a single leg
    const fetchLegFlights = useCallback(async (key: string, leg: FlightLegItem) => {
        if (fetchedKeys.current.has(key)) return;
        fetchedKeys.current.add(key);
        setLegStates(prev => ({ ...prev, [key]: { isLoading: true, flights: [], error: null } }));
        try {
            const qp = new URLSearchParams({
                originLocationCode:      leg.fromIata,
                destinationLocationCode: leg.toIata,
                departureDate:           leg.date || new Date().toISOString().split("T")[0],
                adults:                  "1",
                currencyCode:            finalCurrency,
            });
            if (tripId) qp.append("tripId", tripId);
            const res = await fetch(API + "/flights/search?" + qp.toString());
            if (!res.ok) throw new Error("Flight search failed");
            const json = await res.json();
            setLegStates(prev => ({ ...prev, [key]: { isLoading: false, flights: json.data || [], error: null } }));
        } catch (err: any) {
            setLegStates(prev => ({ ...prev, [key]: { isLoading: false, flights: [], error: err.message || "Failed" } }));
        }
    }, [tripId, finalCurrency, API]);

    // Build journey groups:
    // Outbound: Origin -> Destination (composed of all outbound legs)
    // Return: Destination -> Origin (composed of all return legs)
    const journeyGroups: JourneyGroup[] = (() => {
        if (!legsData) return [];
        const result: JourneyGroup[] = [];
        const outLegs = legsData.outbound || [];
        const retLegs = legsData.return || [];

        if (outLegs.length > 0) {
            result.push({
                direction: "outbound",
                origin: outLegs[0].from,
                originIata: outLegs[0].fromIata,
                destination: outLegs[outLegs.length - 1].to,
                destinationIata: outLegs[outLegs.length - 1].toIata,
                date: outLegs[0].date,
                legs: outLegs,
            });
        }
        if (retLegs.length > 0) {
            result.push({
                direction: "return",
                origin: retLegs[0].from,
                originIata: retLegs[0].fromIata,
                destination: retLegs[retLegs.length - 1].to,
                destinationIata: retLegs[retLegs.length - 1].toIata,
                date: retLegs[0].date,
                legs: retLegs,
            });
        }
        return result;
    })();

    // Eagerly fetch all legs when data is ready
    useEffect(() => {
        if (legsStatus !== "ready") return;
        if (!legsData) return;
        const allLegs = [...(legsData.outbound || []), ...(legsData.return || [])];
        for (const leg of allLegs) {
            const key = `${leg.legNum}#${leg.fromIata}#${leg.toIata}#${leg.date}`;
            fetchLegFlights(key, leg);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [legsStatus]);

    // --- Loading ---
    if (legsStatus === "idle" || legsStatus === "loading") {
        return (
            <div className="space-y-6">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="space-y-4">
                    {[0, 1].map(i => (
                        <div key={i} className="space-y-3">
                            <div className="h-14 w-full rounded-xl bg-white/5 animate-pulse" />
                            <SkeletonLoader type="flights" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // --- Pending ---
    if (legsStatus === "pending") {
        return (
            <div className="space-y-6">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-10 flex flex-col items-center gap-4 border border-white/10">
                    <div className="w-12 h-12 rounded-full bg-sky-500/15 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-white font-semibold">AI Analysing Your Flight Plan...</p>
                        <p className="text-white/50 text-sm mt-1">
                            Finding optimal commercial flights and connections for your complete journey.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // --- Error / no data ---
    if (legsStatus === "error" || !legsData || journeyGroups.length === 0) {
        return (
            <div className="space-y-6">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-8 flex flex-col items-center gap-4 border border-red-500/20">
                    <p className="text-white/60 text-sm">No commercial flight routes required or found for this destination.</p>
                    <button onClick={() => { fetchedKeys.current.clear(); fetchLegs(); }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition-all cursor-pointer">
                        <RefreshCw className="w-4 h-4" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    // Active selected journey group (defaults to Outbound)
    const activeGroup = journeyGroups.find(g => g.direction === selectedDirection) || journeyGroups[0];
    const isReturn = activeGroup.direction === "return";

    // Check loading state across all legs in the active journey
    const legStateList = activeGroup.legs.map(l => {
        const k = `${l.legNum}#${l.fromIata}#${l.toIata}#${l.date}`;
        return legStates[k];
    });
    const isGroupLoading = legStateList.some(s => !s || s.isLoading);
    const hasGroupError  = legStateList.some(s => s && s.error);

    // Build complete journey options from raw legs
    const allJourneys = combineMultiLegFlights(activeGroup, legStates, finalCurrency);

    // --- JOURNEY-LEVEL FILTERING & SORTING ---
    // 1. Filter by Stops / Direct
    let filteredJourneys = [...allJourneys];
    const isDirectRequested = sortBy === "DIRECT" || maxStops === 0;

    if (isDirectRequested) {
        filteredJourneys = filteredJourneys.filter(j => j.stopCount === 0);
    } else if (maxStops !== null) {
        filteredJourneys = filteredJourneys.filter(j => j.stopCount <= maxStops);
    }

    // 2. Sort by selected criterion
    if (sortBy === "CHEAPEST") {
        filteredJourneys.sort((a, b) => (a.totalPrice || 0) - (b.totalPrice || 0));
    } else if (sortBy === "FASTEST") {
        filteredJourneys.sort((a, b) => (a.totalDurationMinutes || 0) - (b.totalDurationMinutes || 0));
    } else if (sortBy === "DIRECT") {
        filteredJourneys.sort((a, b) => {
            if (a.stopCount !== b.stopCount) return a.stopCount - b.stopCount;
            return (a.totalPrice || 0) - (b.totalPrice || 0);
        });
    } else {
        // BEST: matchScore descending, then heuristic duration + price
        filteredJourneys.sort((a, b) => {
            const scoreA = a.matchScore ?? 80;
            const scoreB = b.matchScore ?? 80;
            if (scoreA !== scoreB) return scoreB - scoreA;
            const algA = (a.totalPrice || 0) + (a.totalDurationMinutes || 0) * 0.5;
            const algB = (b.totalPrice || 0) + (b.totalDurationMinutes || 0) * 0.5;
            return algA - algB;
        });
    }

    const directFilteredOut = isDirectRequested && filteredJourneys.length === 0 && allJourneys.length > 0;

    return (
        <div className="space-y-6">
            {/* ── 1. Top Outbound + Return Journey Switcher ── */}
            {journeyGroups.length > 1 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                    {journeyGroups.map((group) => {
                        const isSelected = selectedDirection === group.direction;
                        const isRet = group.direction === "return";
                        return (
                            <button
                                key={group.direction}
                                onClick={() => setSelectedDirection(group.direction)}
                                className={`p-4 rounded-2xl border text-left transition-all duration-200 cursor-pointer flex items-center justify-between gap-3 ${
                                    isSelected
                                        ? isRet
                                            ? "bg-purple-500/15 border-purple-500/40 shadow-[0_0_20px_rgba(168,85,247,0.2)] text-white"
                                            : "bg-sky-500/15 border-sky-500/40 shadow-[0_0_20px_rgba(14,165,233,0.2)] text-white"
                                        : "bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-white/70 hover:text-white"
                                }`}
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                                        isSelected
                                            ? isRet ? "bg-purple-500/30 text-purple-300" : "bg-sky-500/30 text-sky-300"
                                            : "bg-white/10 text-white/50"
                                    }`}>
                                        <Plane className={`w-4 h-4 ${isRet ? "-rotate-45" : "rotate-45"}`} />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                                                isSelected
                                                    ? isRet
                                                        ? "bg-purple-500/20 border-purple-500/40 text-purple-200"
                                                        : "bg-sky-500/20 border-sky-500/40 text-sky-200"
                                                    : "bg-white/5 border-white/10 text-white/50"
                                            }`}>
                                                {isRet ? "Return" : "Outbound"}
                                            </span>
                                            <span className="text-xs text-white/50 font-medium">{fmtDisplay(group.date)}</span>
                                        </div>
                                        <p className="text-sm font-bold text-white truncate mt-1">
                                            {formatAirportCity(group.origin, group.originIata)} → {formatAirportCity(group.destination, group.destinationIata)}
                                        </p>
                                    </div>
                                </div>
                                {isSelected && (
                                    <span className={`text-xs font-bold px-2.5 py-1 rounded-lg ${
                                        isRet ? "bg-purple-500/30 text-purple-200" : "bg-sky-500/30 text-sky-200"
                                    }`}>
                                        Active
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* ── 2. Filters (Applied to the Selected Complete Journey) ── */}
            <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />

            {/* ── 3. Active Journey Results Container ── */}
            <div className="space-y-4">
                {/* Loading State */}
                {isGroupLoading && <SkeletonLoader type="flights" />}

                {/* Error State */}
                {!isGroupLoading && hasGroupError && allJourneys.length === 0 && (
                    <div className="glass-panel p-6 rounded-xl border border-red-500/10 text-center space-y-3">
                        <p className="text-red-400 text-sm">Could not find automated flights for this route.</p>
                        <DirectBookingLinks orgCode={activeGroup.originIata} destCode={activeGroup.destinationIata} travelDate={activeGroup.date} />
                    </div>
                )}

                {/* Direct Filter: No Direct Flights Available */}
                {!isGroupLoading && directFilteredOut && (
                    <div className="glass-panel p-6 rounded-2xl border border-sky-500/20 bg-sky-500/5 text-center space-y-3">
                        <div className="w-10 h-10 rounded-full bg-sky-500/15 flex items-center justify-center mx-auto text-sky-400">
                            <Plane className="w-5 h-5" />
                        </div>
                        <div>
                            <p className="text-white font-semibold text-sm">
                                No direct flights found for <span className="text-sky-300">{formatAirportCity(activeGroup.origin, activeGroup.originIata)} → {formatAirportCity(activeGroup.destination, activeGroup.destinationIata)}</span>
                            </p>
                            <p className="text-white/60 text-xs mt-1">
                                Valid 1-stop and connecting flights are available for this route ({allJourneys.length} total options found).
                            </p>
                        </div>
                        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                            <button
                                onClick={() => { setMaxStops(null); if (sortBy === "DIRECT") setSortBy("BEST"); }}
                                className="px-4 py-2 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 text-xs font-semibold transition-all shadow-md cursor-pointer"
                            >
                                Show All {allJourneys.length} Available Flights
                            </button>
                        </div>
                        <div className="pt-3 border-t border-white/5 flex flex-wrap items-center justify-center gap-2">
                            <span className="text-[10px] text-white/40 font-medium">Or compare directly on booking platforms:</span>
                            <DirectBookingLinks orgCode={activeGroup.originIata} destCode={activeGroup.destinationIata} travelDate={activeGroup.date} />
                        </div>
                    </div>
                )}

                {/* Empty State (Any / Stops Filtered Out) */}
                {!isGroupLoading && !directFilteredOut && filteredJourneys.length === 0 && (
                    <div className="glass-panel p-6 rounded-2xl border border-white/10 text-center space-y-3">
                        <Search className="w-8 h-8 text-white/20 mx-auto" />
                        <p className="text-white/70 text-sm">
                            No commercial flights currently found for <strong className="text-white">{formatAirportCity(activeGroup.origin, activeGroup.originIata)} → {formatAirportCity(activeGroup.destination, activeGroup.destinationIata)}</strong> on {fmtDisplay(activeGroup.date)}
                        </p>
                        <p className="text-white/40 text-xs">Compare prices directly on booking providers:</p>
                        <DirectBookingLinks orgCode={activeGroup.originIata} destCode={activeGroup.destinationIata} travelDate={activeGroup.date} />
                    </div>
                )}

                {/* Complete Journey Cards */}
                {!isGroupLoading && filteredJourneys.length > 0 && (
                    <div className="space-y-4">
                        <AnimatePresence mode="popLayout">
                            {filteredJourneys.slice(0, 6).map((journey, idx) => (
                                <motion.div
                                    key={journey.id}
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <CompleteJourneyCard
                                        journey={journey}
                                        isReturn={isReturn}
                                        isTopRecommended={idx === 0 && sortBy === "BEST"}
                                    />
                                </motion.div>
                            ))}
                        </AnimatePresence>

                        {/* Direct Booking Comparison Links Footer */}
                        <div className="flex items-center justify-center gap-2 pt-2 border-t border-white/5">
                            <span className="text-[10px] text-white/40 font-medium">Compare live prices on external platforms:</span>
                            <DirectBookingLinks orgCode={activeGroup.originIata} destCode={activeGroup.destinationIata} travelDate={activeGroup.date} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}