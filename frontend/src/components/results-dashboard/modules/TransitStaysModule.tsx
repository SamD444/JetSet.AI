"use client";

import { useState, useEffect, useCallback } from "react";
import { Train, Bus, Map, ExternalLink, Loader2, RefreshCw, ArrowRight, MessageCircle } from "lucide-react";
import { getApiUrl } from "@/utils/api";
import { ModuleProps } from "./types";

interface TransitOption {
  mode: string;
  partner: string;
  label: string;
  description: string;
  bookingUrl: string;
  icon: string;
}

interface RuralStay {
  id: number;
  name: string;
  lat: number;
  lon: number;
  type: string;
  contact_whatsapp?: string;
  contact_phone?: string;
  website?: string;
  source: string;
  price_band: string;
  village_name?: string;
  district?: string;
  state?: string;
  amenities?: string[];
  description?: string;
  whatsappLink?: string;
}

const PRICE_BADGES: Record<string, { label: string; color: string }> = {
  budget: { label: "₹ Budget", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  mid: { label: "₹₹ Mid-range", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  premium: { label: "₹₹₹ Premium", color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
};

const TYPE_LABELS: Record<string, string> = {
  homestay: "🏡 Homestay",
  camp_site: "⛺ Campsite",
  hostel: "🛏️ Hostel",
  dharamshala: "🕉️ Dharamshala",
  guest_house: "🏠 Guest House",
};

export default function TransitStaysModule({ tripId, org, dest, dates }: ModuleProps) {
  const [transitOptions, setTransitOptions] = useState<TransitOption[]>([]);
  const [ruralStays, setRuralStays] = useState<RuralStay[]>([]);
  const [transitLoading, setTransitLoading] = useState(true);
  const [staysLoading, setStaysLoading] = useState(false);
  const [transitError, setTransitError] = useState<string | null>(null);
  const [staysError, setStaysError] = useState<string | null>(null);
  const [activePriceBand, setActivePriceBand] = useState<string>("all");
  const [stationInfo, setStationInfo] = useState<{ source: string; destination: string } | null>(null);

  const API = getApiUrl();

  // Parse date from "YYYY-MM-DD to YYYY-MM-DD" format
  const fromDate = dates?.split(" to ")?.[0] || dates || "";

  // ─── Fetch Transit Options ─────────────────────────────────────────────
  const fetchTransit = useCallback(async () => {
    if (!org || !dest || !fromDate) {
      setTransitLoading(false);
      return;
    }
    setTransitLoading(true);
    setTransitError(null);
    try {
      const params = new URLSearchParams({ source: org, destination: dest, date: fromDate });
      const res = await fetch(`${API}/transit/options?${params}`);
      if (!res.ok) throw new Error("Failed to fetch transit options");
      const data = await res.json();
      setTransitOptions(data.options || []);
      setStationInfo(data.stationCodes || null);
    } catch (err: any) {
      setTransitError(err.message);
    } finally {
      setTransitLoading(false);
    }
  }, [org, dest, fromDate, API]);

  // ─── Fetch Rural Stays ─────────────────────────────────────────────────
  const fetchStays = useCallback(async () => {
    if (!dest) return;
    setStaysLoading(true);
    setStaysError(null);
    try {
      // Send the query string directly to the backend. 
      // The NestJS backend will safely handle Nominatim geocoding server-side (avoids browser CORS/User-Agent blocking)
      const params = new URLSearchParams({
        q: dest,
        radius: "15",
        date: fromDate,
      });
      if (activePriceBand !== "all") params.append("priceBand", activePriceBand);
      
      const res = await fetch(`${API}/rural-stays/discover?${params}`);
      
      if (!res.ok) {
        // Fallback to text search if discover fails (e.g. geocoding failed entirely)
        const fbParams = new URLSearchParams({ state: dest });
        if (activePriceBand !== "all") fbParams.append("priceBand", activePriceBand);
        const fallbackRes = await fetch(`${API}/rural-stays/search?${fbParams}`);
        if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            setRuralStays(fallbackData.stays || []);
            return;
        }
        throw new Error("Failed to discover rural stays");
      }

      const data = await res.json();
      setRuralStays(data.stays || []);
    } catch (err: any) {
      setStaysError(err.message);
    } finally {
      setStaysLoading(false);
    }
  }, [dest, activePriceBand, fromDate, API]);

  useEffect(() => { fetchTransit(); }, [fetchTransit]);
  useEffect(() => { fetchStays(); }, [fetchStays]);

  const modeIcon = (icon: string) => {
    switch (icon) {
      case "train": return <Train className="w-5 h-5" />;
      case "bus": return <Bus className="w-5 h-5" />;
      case "map": return <Map className="w-5 h-5" />;
      default: return <ArrowRight className="w-5 h-5" />;
    }
  };

  const modeColor = (icon: string) => {
    switch (icon) {
      case "train": return "from-sky-500/20 to-sky-600/5 border-sky-500/30 hover:border-sky-400/50";
      case "bus": return "from-rose-500/20 to-rose-600/5 border-rose-500/30 hover:border-rose-400/50";
      case "map": return "from-amber-500/20 to-amber-600/5 border-amber-500/30 hover:border-amber-400/50";
      default: return "from-white/10 to-white/5 border-white/20";
    }
  };

  const modeIconColor = (icon: string) => {
    switch (icon) {
      case "train": return "text-sky-400";
      case "bus": return "text-rose-400";
      case "map": return "text-amber-400";
      default: return "text-white/60";
    }
  };

  // ─── Handle redirect click ─────────────────────────────────────────────
  const handleRedirect = (option: TransitOption) => {
    // Log click via backend redirect endpoint, then open URL
    const params = new URLSearchParams({
      partner: option.partner,
      type: option.mode,
      tripId: tripId || "anonymous",
      source: org || "",
      destination: dest || "",
      date: fromDate,
    });
    window.open(`${API}/transit/redirect?${params}`, "_blank");
  };

  return (
    <div className="w-full h-full pb-10 space-y-10">
      {/* ─── SECTION 1: Ground Transit ─────────────────────────────────── */}
      <section>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold text-white flex items-baseline gap-2">
              🚂 Ground Transit
              <span className="text-white/40 text-base font-normal">
                ({transitOptions.length} routes)
              </span>
            </h2>
            <p className="text-white/50 text-sm mt-1">
              Trains, buses, and multi-modal routes from {org || "origin"} to {dest || "destination"}
            </p>
          </div>
          {!transitLoading && (
            <button
              onClick={fetchTransit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/80 text-xs transition-all"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          )}
        </div>

        {transitLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-40 rounded-2xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : transitError ? (
          <div className="glass-panel rounded-2xl p-6 border border-red-500/20 text-center">
            <p className="text-red-400 text-sm">{transitError}</p>
            <button onClick={fetchTransit} className="mt-3 text-xs text-white/50 hover:text-white/80 flex items-center gap-1 mx-auto">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : transitOptions.length === 0 ? (
          <div className="glass-panel rounded-2xl p-8 text-center border border-white/10">
            <Train className="w-8 h-8 mx-auto mb-3 text-white/20" />
            <p className="text-white/50 text-sm">No transit routes found. Try specifying valid Indian city names.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {transitOptions.map((option, i) => (
              <button
                key={i}
                onClick={() => handleRedirect(option)}
                className={`group relative overflow-hidden rounded-2xl p-5 border bg-gradient-to-br ${modeColor(option.icon)} transition-all duration-300 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] cursor-pointer text-left`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0 ${modeIconColor(option.icon)}`}>
                    {modeIcon(option.icon)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm leading-tight truncate">
                      {option.label}
                    </p>
                    <p className="text-white/50 text-xs mt-1">{option.description}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-white/30 font-mono uppercase">{option.partner}</span>
                  <span className="flex items-center gap-1 text-xs text-white/60 group-hover:text-white transition-colors">
                    Book Now <ExternalLink className="w-3 h-3" />
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Station Code Info */}
        {stationInfo && (stationInfo.source !== "not_found" || stationInfo.destination !== "not_found") && (
          <div className="mt-4 flex flex-wrap gap-3">
            {stationInfo.source !== "not_found" && (
              <span className="text-xs px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-300/80">
                📍 {org} → Station: <strong>{stationInfo.source}</strong>
              </span>
            )}
            {stationInfo.destination !== "not_found" && (
              <span className="text-xs px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-300/80">
                📍 {dest} → Station: <strong>{stationInfo.destination}</strong>
              </span>
            )}
          </div>
        )}
      </section>

      {/* ─── SECTION 2: Rural / Village Stays ──────────────────────────── */}
      <section>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h2 className="text-xl font-bold text-white flex items-baseline gap-2">
              🏡 Village & Rural Stays
              <span className="text-white/40 text-base font-normal">
                ({ruralStays.length} found)
              </span>
            </h2>
            <p className="text-white/50 text-sm mt-1">
              Homestays, dharamshalas, and campsites near {dest || "your destination"}
            </p>
          </div>

          {/* Price Band Filters */}
          <div className="flex gap-2">
            {["all", "budget", "mid", "premium"].map(band => (
              <button
                key={band}
                onClick={() => setActivePriceBand(band)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
                  activePriceBand === band
                    ? "bg-white/15 border-white/30 text-white"
                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white/70"
                }`}
              >
                {band === "all" ? "All" : PRICE_BADGES[band]?.label || band}
              </button>
            ))}
          </div>
        </div>

        {staysLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-48 rounded-2xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : staysError ? (
          <div className="glass-panel rounded-2xl p-6 border border-red-500/20 text-center">
            <p className="text-red-400 text-sm">{staysError}</p>
            <button onClick={fetchStays} className="mt-3 text-xs text-white/50 hover:text-white/80 flex items-center gap-1 mx-auto">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : ruralStays.length === 0 ? (
          <div className="glass-panel rounded-2xl p-8 text-center border border-white/10">
            <div className="text-3xl mb-3">🏡</div>
            <p className="text-white/50 text-sm">No rural stays found yet for <strong className="text-white/70">{dest}</strong>.</p>
            <p className="text-white/30 text-xs mt-1">Try using the coordinate-based discovery or check back as our database grows.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[600px] overflow-y-auto pr-1 custom-scrollbar">
            {ruralStays.map((stay, idx) => {
              const badge = PRICE_BADGES[stay.price_band] || PRICE_BADGES.budget;
              const typeLabel = TYPE_LABELS[stay.type] || "🏠 Stay";
              return (
                <div
                  key={stay.id || stay.osm_id || `${stay.name}-${idx}`}
                  className="group glass-panel rounded-2xl p-5 border border-white/10 hover:border-emerald-500/30 transition-all duration-300 hover:shadow-lg hover:shadow-emerald-500/5 flex flex-col"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-white font-semibold text-sm leading-tight truncate">{stay.name}</h3>
                      {stay.village_name && (
                        <p className="text-white/40 text-xs mt-0.5 truncate">
                          📍 {stay.village_name}{stay.district ? `, ${stay.district}` : ""}{stay.state ? `, ${stay.state}` : ""}
                        </p>
                      )}
                    </div>
                    <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border ${badge.color}`}>
                      {badge.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/60">
                      {typeLabel}
                    </span>
                    <span className="text-xs text-white/30">via {stay.source}</span>
                  </div>

                  {/* Amenities */}
                  {stay.amenities && stay.amenities.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {stay.amenities.slice(0, 4).map((a, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/40">{a}</span>
                      ))}
                    </div>
                  )}

                  {stay.description && (
                    <p className="text-white/40 text-xs mb-3 line-clamp-2">{stay.description}</p>
                  )}

                  <div className="mt-auto flex gap-2">
                    {stay.whatsappLink && (
                      <a
                        href={stay.whatsappLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-medium transition-all"
                      >
                        <MessageCircle className="w-3.5 h-3.5" /> WhatsApp Host
                      </a>
                    )}
                    {stay.website && (
                      <a
                        href={stay.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 text-xs font-medium transition-all"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Website
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
