"use client";

import { getApiUrl } from '@/utils/api';

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    ExternalLink, Search, Plane, CalendarDays,
    Loader2, RefreshCw,
} from "lucide-react";
import SkeletonLoader from "../SkeletonLoader";
import { ModuleProps } from "./types";
import { useUserCurrency } from "@/hooks/useUserCurrency";
import { FlightCard } from "@/components/flights/FlightCard";
import { FlightFilters, SortOption } from "@/components/flights/FlightFilters";
import { compareFlights } from "@/utils/flight-utils";
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

type Journey = {
    direction: "outbound" | "return";
    origin: string;
    originIata: string;
    destination: string;
    destinationIata: string;
    date: string;
    legs: FlightLegItem[];
};

// --- Helpers ---

const fmtDisplay = (iso: string): string => {
    return formatSingleDisplayDate(iso, "day-month");
};

// --- Booking Links ---

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

// --- FlightsModule ---

export default function FlightsModule({ tripId, org, dest, dates, curr }: ModuleProps) {
    const localeCurrency = useUserCurrency();
    const finalCurrency  = curr || localeCurrency;
    const API = getApiUrl();

    const [legsData,    setLegsData]    = useState<FlightLegsData | null>(null);
    const [legsStatus,  setLegsStatus]  = useState<"idle" | "loading" | "pending" | "ready" | "error">("idle");
    const [legStates,   setLegStates]   = useState<Record<string, LegState>>({});
    const [expandedLegs, setExpandedLegs] = useState<Record<string, boolean>>({});
    const fetchedKeys   = useRef<Set<string>>(new Set());
    const pollTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollCountRef  = useRef(0);
    const MAX_POLL = 15;

    const [sortBy,   setSortBy]   = useState<SortOption>("BEST");
    const [maxStops, setMaxStops] = useState<number | null>(null);

    const toggleLeg = (key: string) =>
        setExpandedLegs(prev => ({ ...prev, [key]: !(prev[key] ?? true) }));
    const isLegExpanded = (key: string) => expandedLegs[key] ?? true;

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
    // all outbound legs -> ONE Outbound journey (e.g. CCU->DEL + DEL->FCO = CCU->FCO)
    // all return legs   -> ONE Return journey  (e.g. FCO->DEL + DEL->CCU = FCO->CCU)
    const journeys: Journey[] = (() => {
        if (!legsData) return [];
        const result: Journey[] = [];
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
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="space-y-6">
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
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-10 flex flex-col items-center gap-4 border border-white/10">
                    <div className="w-12 h-12 rounded-full bg-sky-500/15 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-white font-semibold">AI Analysing Your Flight Plan...</p>
                        <p className="text-white/50 text-sm mt-1">
                            Finding optimal commercial flights. Stays and domestic connections will load soon.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // --- Error / no data ---
    if (legsStatus === "error" || !legsData || journeys.length === 0) {
        return (
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-8 flex flex-col items-center gap-4 border border-red-500/20">
                    <p className="text-white/60 text-sm">No commercial flight routes required or found for this destination.</p>
                    <button onClick={() => { fetchedKeys.current.clear(); fetchLegs(); }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition-all">
                        <RefreshCw className="w-4 h-4" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    // --- Main render: Outbound + Return journey groups ---
    return (
        <div className="space-y-8">
            <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />

            {journeys.map((journey, jIdx) => {
                const isReturn     = journey.direction === "return";
                const accentBg     = isReturn ? "bg-purple-500/10"    : "bg-sky-500/10";
                const accentBorder = isReturn ? "border-purple-500/20" : "border-sky-500/20";
                const accentText   = isReturn ? "text-purple-300"     : "text-sky-300";
                const iconColor    = isReturn ? "text-purple-400"     : "text-sky-400";
                const badgeCls     = isReturn
                    ? "bg-purple-500/15 border-purple-500/30 text-purple-300"
                    : "bg-sky-500/15 border-sky-500/30 text-sky-300";

                // Intermediate via cities (departure city of each leg after the first)
                const viaCities = journey.legs.length > 1
                    ? journey.legs.slice(1).map(l => l.from)
                    : [];

                return (
                    <motion.div
                        key={`${journey.direction}-${jIdx}`}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: jIdx * 0.06 }}
                        className="space-y-4"
                    >
                        {/* Journey Header: Outbound/Return badge + origin->destination */}
                        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl ${accentBg} border ${accentBorder}`}>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${accentBg} border ${accentBorder}`}>
                                <Plane className={`w-3.5 h-3.5 ${iconColor} ${isReturn ? "-rotate-45" : "rotate-45"}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badgeCls}`}>
                                        {isReturn ? "Return" : "Outbound"}
                                    </span>
                                    <h3 className="text-sm font-bold text-white">
                                        {journey.origin} {"->"} {journey.destination}
                                    </h3>
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-white/40 mt-0.5 flex-wrap">
                                    <CalendarDays className="w-3.5 h-3.5 shrink-0" />
                                    <span>{fmtDisplay(journey.date)}</span>
                                    {viaCities.length > 0 ? (
                                        <span className="text-white/30">
                                            {" "}· {viaCities.length} stop{viaCities.length > 1 ? "s" : ""} via {viaCities.join(", ")}
                                        </span>
                                    ) : (
                                        <span className="text-white/30"> · Nonstop</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Leg Sections */}
                        <div className="space-y-4">
                            {journey.legs.map((leg, legIdx) => {
                                const key        = `${leg.legNum}#${leg.fromIata}#${leg.toIata}#${leg.date}`;
                                const state      = legStates[key];
                                const isMultiLeg = journey.legs.length > 1;
                                const expanded   = isLegExpanded(key);

                                // Filter + sort
                                let sorted: any[] = [];
                                let directFiltered = false;
                                if (state && !state.isLoading && !state.error) {
                                    sorted = [...state.flights];
                                    if (maxStops !== null) {
                                        const before = sorted.length;
                                        sorted = sorted.filter(f => {
                                            const segs = f.itineraries?.[0]?.segments || [];
                                            return (segs.length > 0 ? segs.length - 1 : 0) <= maxStops;
                                        });
                                        if (sorted.length === 0 && maxStops === 0 && before > 0) directFiltered = true;
                                    }
                                    sorted.sort((a, b) => compareFlights(a, b, sortBy));
                                }

                                return (
                                    <div key={key} className="space-y-2">
                                        {/* Collapsible segment header - only for multi-leg journeys */}
                                        {isMultiLeg && (
                                            <button
                                                onClick={() => toggleLeg(key)}
                                                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/8 transition-all"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${accentBg} ${accentText}`}>
                                                        {legIdx + 1}
                                                    </div>
                                                    <span className="text-xs font-semibold text-white">Segment {legIdx + 1}:</span>
                                                    <span className={`text-xs font-mono ${accentText}`}>{leg.fromIata} {"->"} {leg.toIata}</span>
                                                    <span className="text-[10px] text-white/40">({fmtDisplay(leg.date)})</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {state && !state.isLoading && !state.error && (
                                                        <span className="text-[10px] text-white/40">{state.flights.length} option{state.flights.length !== 1 ? "s" : ""}</span>
                                                    )}
                                                    <span className="text-[10px] text-white/30">{expanded ? "^" : "v"}</span>
                                                </div>
                                            </button>
                                        )}

                                        {/* Flight results */}
                                        <AnimatePresence initial={false}>
                                            {(!isMultiLeg || expanded) && (
                                                <motion.div
                                                    key="content"
                                                    initial={{ height: 0, opacity: 0 }}
                                                    animate={{ height: "auto", opacity: 1 }}
                                                    exit={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.2 }}
                                                    className="overflow-hidden"
                                                >
                                                    <div className="space-y-3 pt-1">
                                                        {(!state || state.isLoading) && <SkeletonLoader type="flights" />}

                                                        {state && !state.isLoading && state.error && (
                                                            <div className="glass-panel p-6 rounded-xl border border-red-500/10 text-center">
                                                                <p className="text-red-400 text-sm mb-3">Could not search flights: {state.error}</p>
                                                                <DirectBookingLinks orgCode={leg.fromIata} destCode={leg.toIata} travelDate={leg.date} />
                                                            </div>
                                                        )}

                                                        {state && !state.isLoading && !state.error && directFiltered && (
                                                            <div className="space-y-4">
                                                                <div className="glass-panel p-5 rounded-xl border border-sky-500/20 bg-sky-500/5 text-center">
                                                                    <p className="text-white font-medium text-sm mb-1">
                                                                        No direct flights found for <strong className="text-sky-300">{leg.fromIata} {"->"} {leg.toIata}</strong>
                                                                    </p>
                                                                    <p className="text-white/60 text-xs mb-3">
                                                                        Valid 1-stop and connecting flights are available for this route ({state.flights.length} options found).
                                                                    </p>
                                                                    <button onClick={() => setMaxStops(null)}
                                                                        className="px-4 py-2 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 text-xs font-semibold transition-all shadow-md cursor-pointer">
                                                                        Show All {state.flights.length} Available Flights
                                                                    </button>
                                                                </div>
                                                                <div className="flex items-center justify-center gap-2 pt-1 border-t border-white/5">
                                                                    <span className="text-[10px] text-white/30 font-medium">Or compare on external platforms:</span>
                                                                    <DirectBookingLinks orgCode={leg.fromIata} destCode={leg.toIata} travelDate={leg.date} />
                                                                </div>
                                                            </div>
                                                        )}

                                                        {state && !state.isLoading && !state.error && !directFiltered && sorted.length === 0 && (
                                                            <div className="glass-panel p-5 rounded-xl border border-white/5 text-center">
                                                                <Search className="w-7 h-7 text-white/20 mx-auto mb-2" />
                                                                <p className="text-white/60 text-sm mb-1">
                                                                    No commercial flights currently found for <strong className="text-white/80">{leg.fromIata} {"->"} {leg.toIata}</strong> on {fmtDisplay(leg.date)}
                                                                </p>
                                                                <p className="text-white/30 text-xs mb-2">Compare on booking platforms directly:</p>
                                                                <DirectBookingLinks orgCode={leg.fromIata} destCode={leg.toIata} travelDate={leg.date} />
                                                            </div>
                                                        )}

                                                        {state && !state.isLoading && !state.error && !directFiltered && sorted.length > 0 && (
                                                            <div className="space-y-3">
                                                                <AnimatePresence mode="popLayout">
                                                                    {sorted.slice(0, 5).map((flight, fIdx) => (
                                                                        <motion.div key={flight.id || fIdx}
                                                                            initial={{ opacity: 0, y: 8 }}
                                                                            animate={{ opacity: 1, y: 0 }}
                                                                            exit={{ opacity: 0 }}
                                                                            transition={{ duration: 0.15 }}>
                                                                            <FlightCard flight={flight} />
                                                                        </motion.div>
                                                                    ))}
                                                                </AnimatePresence>
                                                                <div className="flex items-center justify-center gap-2 pt-1 border-t border-white/5">
                                                                    <span className="text-[10px] text-white/30 font-medium">Compare prices:</span>
                                                                    <DirectBookingLinks orgCode={leg.fromIata} destCode={leg.toIata} travelDate={leg.date} />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                );
                            })}
                        </div>
                    </motion.div>
                );
            })}
        </div>
    );
}