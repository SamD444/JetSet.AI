"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import SkeletonLoader from "../SkeletonLoader";
import { ModuleProps } from "./types";
import HotelCard, { HotelData } from "./hotels/HotelCard";
import HotelMap from "./hotels/HotelMap";
import { MapPin, CalendarDays, Loader2, RefreshCw } from "lucide-react";
import { getApiUrl } from "@/utils/api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ItineraryStop {
    city: string;
    dayStart: number;
    dayEnd: number;
    checkin: string;
    checkout: string;
    displayCheckin: string;
    displayCheckout: string;
}

interface StopHotelState {
    isLoading: boolean;
    hotels: HotelData[];
    error: string | null;
    selectedHotelId: string | null;
    cityCode: string;
}

// ─── HotelsModule ─────────────────────────────────────────────────────────────

export default function HotelsModule({ tripId, dest, dates, curr }: ModuleProps) {
    const [tripData, setTripData] = useState<any>(null);
    const [stops, setStops] = useState<ItineraryStop[]>([]);
    const [stopsStatus, setStopsStatus] = useState<"idle" | "loading" | "pending" | "ready" | "error">("idle");
    const [activeTab, setActiveTab] = useState(0);
    const [stopStates, setStopStates] = useState<Record<number, StopHotelState>>({});
    const fetchedKeys = useRef<Set<string>>(new Set());
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollCountRef = useRef(0);
    const MAX_POLL = 15; // max ~45 seconds polling

    const API = getApiUrl();

    // ── 1. Load tripData ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!tripId) return;
        fetch(API + "/trips/" + tripId)
            .then(r => r.ok ? r.json() : null)
            .then(d => d && setTripData(d))
            .catch(() => {});
    }, [tripId, API]);

    // ── 2. Fetch itinerary stops from Gemini endpoint ────────────────────────
    const fetchStops = useCallback(async () => {
        if (!tripId) return;
        setStopsStatus("loading");
        try {
            const res = await fetch(API + "/trips/" + tripId + "/itinerary-stops");
            if (!res.ok) throw new Error("endpoint error");
            const data = await res.json();

            if (data.status === "pending") {
                setStopsStatus("pending");
                return;
            }

            const rawStops: ItineraryStop[] = data.stops || [];
            setStops(rawStops);
            setStopsStatus("ready");
            setActiveTab(0);
            fetchedKeys.current.clear(); // clear so tabs re-fetch on new stops
        } catch {
            setStopsStatus("error");
        }
    }, [tripId, API]);

    useEffect(() => {
        if (tripId) fetchStops();
    }, [tripId, dest, dates, fetchStops]);

    // Listen for trip and itinerary updates to immediately invalidate and refresh hotel coverage
    useEffect(() => {
        const handleTripOrItinUpdated = () => {
            fetchedKeys.current.clear();
            fetchStops();
        };

        window.addEventListener("copilot-trip-updated", handleTripOrItinUpdated);
        window.addEventListener("copilot-itinerary-updated", handleTripOrItinUpdated);
        return () => {
            window.removeEventListener("copilot-trip-updated", handleTripOrItinUpdated);
            window.removeEventListener("copilot-itinerary-updated", handleTripOrItinUpdated);
        };
    }, [fetchStops]);

    // ── 3. Poll if plan is still being generated ──────────────────────────────
    useEffect(() => {
        if (stopsStatus !== "pending") {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            pollCountRef.current = 0;
            return;
        }
        if (pollCountRef.current >= MAX_POLL) {
            setStopsStatus("error");
            return;
        }
        pollTimerRef.current = setTimeout(async () => {
            pollCountRef.current++;
            await fetchStops();
        }, 3000);
        return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
    }, [stopsStatus, fetchStops]);

    // ── 4. Resolve city → IATA code ──────────────────────────────────────────
    const resolveCityCode = useCallback(async (city: string): Promise<string> => {
        const m = city.match(/\b([A-Z]{3})\b/);
        if (m) return m[1];
        try {
            const res = await fetch(API + "/hotels/autocomplete?" + new URLSearchParams({ keyword: city }));
            if (res.ok) {
                const d = await res.json();
                const f = (d.data || [])[0];
                return f?.address?.cityCode || f?.iataCode || city;
            }
        } catch { /**/ }
        return city;
    }, [API]);

    // ── 5. Fetch hotels for a single stop (with AI scoring) ──────────────────
    const fetchStop = useCallback(async (idx: number, stop: ItineraryStop) => {
        const key = `${idx}#${stop.city}#${stop.checkin}`;
        if (fetchedKeys.current.has(key)) return;
        fetchedKeys.current.add(key);

        setStopStates(p => ({
            ...p,
            [idx]: { isLoading: true, hotels: [], error: null, selectedHotelId: null, cityCode: "" },
        }));

        try {
            const cc = await resolveCityCode(stop.city);
            const qp = new URLSearchParams({ 
                cityCode: cc,
                cityName: stop.city
            });
            if (stop.checkin)  qp.append("checkin", stop.checkin);
            if (stop.checkout) qp.append("checkout", stop.checkout);
            if (tripId)        qp.append("tripId", tripId);
            if (curr)          qp.append("curr", curr);

            const res = await fetch(API + "/hotels/by-city?" + qp.toString());
            if (!res.ok) throw new Error("Hotel fetch failed");
            const d = await res.json();

            const hotels: HotelData[] = (d.data || []).map((h: any) => ({
                hotelId:     h.hotelId,
                name:        h.name,
                latitude:    h.geoCode?.latitude,
                longitude:   h.geoCode?.longitude,
                distance:    h.distance?.value,
                rating:      h.rating,
                price:       h.price,
                matchScore:  h.matchScore,
                matchReason: h.matchReason,
            }));

            // Sort: AI match score → rating → price
            hotels.sort((a, b) => {
                const scoreDiff = (b.matchScore || 0) - (a.matchScore || 0);
                if (scoreDiff !== 0) return scoreDiff;
                const ratingDiff = (b.rating || 0) - (a.rating || 0);
                if (ratingDiff !== 0) return ratingDiff;
                return (Number(a.price) || 9999) - (Number(b.price) || 9999);
            });

            setStopStates(p => ({
                ...p,
                [idx]: { isLoading: false, hotels, error: null, selectedHotelId: null, cityCode: cc },
            }));
        } catch (e: any) {
            setStopStates(p => ({
                ...p,
                [idx]: { isLoading: false, hotels: [], error: e.message || "Error loading hotels", selectedHotelId: null, cityCode: "" },
            }));
        }
    }, [tripId, curr, resolveCityCode, API]);

    // ── 6. Trigger hotel fetch when active tab changes ────────────────────────
    useEffect(() => {
        if (stops.length === 0) return;
        const stop = stops[activeTab];
        if (stop) fetchStop(activeTab, stop);
    }, [activeTab, stops, fetchStop]);

    // Also prefetch the first tab when stops first arrive
    useEffect(() => {
        if (stops.length > 0) fetchStop(0, stops[0]);
    }, [stops]); // eslint-disable-line

    const selectHotel = (idx: number, hotelId: string | null) =>
        setStopStates(p => ({ ...p, [idx]: { ...p[idx], selectedHotelId: hotelId } }));

    const totalOptions = Object.values(stopStates).reduce((s, st) => s + (st.hotels?.length || 0), 0);
    const activeState = stopStates[activeTab];
    const activeStop  = stops[activeTab];

    // ── Render: pending / error states ───────────────────────────────────────

    if (stopsStatus === "idle" || stopsStatus === "loading") {
        return (
            <div className="w-full h-full pb-10">
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-xl font-bold text-white flex items-baseline gap-2">
                        Hotels by Itinerary
                        <span className="text-white/40 text-base font-normal">(loading…)</span>
                    </h2>
                </div>
                <div className="flex gap-2 mb-6">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-10 w-28 rounded-full bg-white/5 animate-pulse" />
                    ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[1, 2, 3, 4].map(i => <SkeletonLoader key={i} type="hotels" />)}
                </div>
            </div>
        );
    }

    if (stopsStatus === "pending") {
        return (
            <div className="w-full h-full pb-10">
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-xl font-bold text-white">Hotels by Itinerary</h2>
                </div>
                <div className="glass-panel rounded-2xl p-10 flex flex-col items-center justify-center gap-4 border border-white/10">
                    <div className="w-12 h-12 rounded-full bg-sky-500/15 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-white font-semibold">Generating Your Travel Plan…</p>
                        <p className="text-white/50 text-sm mt-1">
                            AI is crafting your itinerary. Hotels will load automatically once ready.
                        </p>
                    </div>
                    <div className="flex gap-1 mt-2">
                        {[0, 1, 2].map(i => (
                            <div key={i} className="w-2 h-2 rounded-full bg-sky-400/60 animate-bounce"
                                style={{ animationDelay: `${i * 0.15}s` }} />
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (stopsStatus === "error" || stops.length === 0) {
        return (
            <div className="w-full h-full pb-10">
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-xl font-bold text-white">Hotels by Itinerary</h2>
                </div>
                <div className="glass-panel rounded-2xl p-8 flex flex-col items-center gap-4 border border-red-500/20">
                    <p className="text-white/60 text-sm">Could not load itinerary stops.</p>
                    <button
                        onClick={() => { fetchedKeys.current.clear(); fetchStops(); }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition-all"
                    >
                        <RefreshCw className="w-4 h-4" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    // ── Render: tab UI ────────────────────────────────────────────────────────

    return (
        <div className="w-full h-full pb-10">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold text-white flex items-baseline gap-2">
                    Hotels by Itinerary
                    <span className="text-white/40 text-base font-normal">
                        ({totalOptions} options across {stops.length} {stops.length === 1 ? "stop" : "stops"})
                    </span>
                </h2>
            </div>

            {/* Tab Pills */}
            <div className="flex flex-wrap gap-2 mb-7 pb-4 border-b border-white/10">
                {stops.map((stop, idx) => {
                    const isActive = idx === activeTab;
                    const dayLabel = stop.dayStart === stop.dayEnd
                        ? `Day ${stop.dayStart}`
                        : `Days ${stop.dayStart}–${stop.dayEnd}`;
                    return (
                        <button
                            key={idx}
                            onClick={() => setActiveTab(idx)}
                            className={[
                                "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 border whitespace-nowrap",
                                isActive
                                    ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-lg shadow-emerald-500/10"
                                    : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/80",
                            ].join(" ")}
                        >
                            <MapPin className={`w-3.5 h-3.5 ${isActive ? "text-emerald-400" : "text-white/40"}`} />
                            <span>{stop.city}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? "bg-emerald-500/30 text-emerald-300" : "bg-white/10 text-white/40"}`}>
                                {dayLabel}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Active Stop Details */}
            {activeStop && (
                <div className="flex items-center gap-3 mb-5">
                    <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                        <MapPin className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div>
                        <h3 className="text-base font-semibold text-white leading-tight">{activeStop.city}</h3>
                        {activeStop.displayCheckin && activeStop.displayCheckout && (
                            <div className="flex items-center gap-1.5 text-xs text-white/40 mt-0.5">
                                <CalendarDays className="w-3 h-3" />
                                <span>
                                    {activeStop.dayStart === activeStop.dayEnd
                                        ? `Day ${activeStop.dayStart}`
                                        : `Days ${activeStop.dayStart}–${activeStop.dayEnd}`}
                                    {" · "}
                                    {activeStop.displayCheckin} → {activeStop.displayCheckout}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Hotel Cards + Map */}
            {(!activeState || activeState.isLoading) ? (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                        {[1, 2, 3, 4].map(i => <SkeletonLoader key={i} type="hotels" />)}
                    </div>
                    <div className="lg:col-span-1 h-[520px] rounded-2xl bg-white/5 animate-pulse" />
                </div>
            ) : activeState.error ? (
                <div className="glass-panel p-6 rounded-2xl border border-red-500/20">
                    <p className="text-red-400 text-sm">{activeState.error}</p>
                    <button
                        onClick={() => {
                            const key = `${activeTab}#${activeStop?.city}#${activeStop?.checkin}`;
                            fetchedKeys.current.delete(key);
                            if (activeStop) fetchStop(activeTab, activeStop);
                        }}
                        className="mt-3 flex items-center gap-2 text-xs text-white/50 hover:text-white/80 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" /> Try again
                    </button>
                </div>
            ) : activeState.hotels.length === 0 ? (
                <div className="glass-panel p-8 text-center text-white/40 text-sm rounded-2xl border border-white/10">
                    <MapPin className="w-8 h-8 mx-auto mb-3 text-white/20" />
                    <p>No hotels found for <strong className="text-white/60">{activeStop?.city}</strong>.</p>
                    <p className="text-xs mt-1 text-white/30">This city may not have bookable hotels in the API yet.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Hotel Cards */}
                    <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[580px] overflow-y-auto pr-1 custom-scrollbar">
                        {activeState.hotels.map((hotel, i) => (
                            <HotelCard
                                key={hotel.hotelId + "-" + i}
                                hotel={hotel}
                                isSelected={activeState.selectedHotelId === hotel.hotelId}
                                onClick={() => selectHotel(activeTab, hotel.hotelId === activeState.selectedHotelId ? null : hotel.hotelId)}
                                cityCode={activeState.cityCode}
                                checkin={activeStop?.checkin}
                                checkout={activeStop?.checkout}
                                curr={curr}
                            />
                        ))}
                    </div>
                    {/* Map */}
                    <div className="lg:col-span-1 h-[580px] rounded-2xl overflow-hidden glass-panel border border-white/10 relative">
                        <HotelMap
                            hotels={activeState.hotels}
                            selectedHotelId={activeState.selectedHotelId}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
