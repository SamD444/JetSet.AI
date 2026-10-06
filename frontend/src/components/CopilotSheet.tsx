"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useCopilotStore } from '@/store/copilotStore';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { CopilotMessage, CopilotResponsePayload } from '@jetset/shared';
import { Loader2, Plane, Hotel, Map, MapPin, Navigation, Send, CheckSquare } from 'lucide-react';
import { getApiUrl } from '@/utils/api';
import { JettyMascot } from './assistant/JettyMascot';
import { useJettyState } from '@/hooks/useJettyState';
import { useRouter, usePathname } from 'next/navigation';
import { formatDisplayDates } from '@/lib/dateUtils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const getSuggestedQuestions = (route: string, view: string) => {
  if (route.includes('/results')) {
    if (view === 'flights') {
      return ["Filter for non-stop only", "Find flights departing after 10 AM", "What is the cheapest day to fly?"];
    }
    if (view === 'hotels') {
      return ["Show me hotels with free breakfast", "Which of these is closest to the airport?", "Sort these by highest rating"];
    }
    if (view === 'itinerary') {
      return ["Swap Day 2 outdoor activities due to rain", "Summarize my final itinerary and generate the packing list", "Are there any good local restaurants near my hotel?"];
    }
    // Default for results page (e.g. summary tab) - showing current things
    return ["Hotels", "Itinerary", "Hidden gems", "Local tips"];
  }
  return [
    "Plan a 3-day itinerary for Santorini",
    "Find me the best local food in Kyoto",
    "What are some hidden gems in Bali?"
  ];
};

export function CopilotSheet() {
  const { isOpen, setIsOpen, messages, addMessage, activeRoute, activeView, draftSelections, setIsStreaming, tripId, setTripId, documentContext } = useCopilotStore();
  const { jettyState } = useJettyState();
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [statusText, setStatusText] = useState('Thinking...');
  const bottomRef = useRef<HTMLDivElement>(null);
  const isSubmittingRef = useRef(false);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);
  const hasNavigatedOrSwitchedRef = useRef(false);
  const router = useRouter();
  const pathname = usePathname();
  
  const suggestedQuestions = useMemo(() => getSuggestedQuestions(activeRoute, activeView), [activeRoute, activeView]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    return () => {
      // Abort any in-flight request when component unmounts
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
      }
      isSubmittingRef.current = false;
    };
  }, []);

  const handleSend = async (overrideInput?: string) => {
    const textToSend = overrideInput || input;
    if (!textToSend.trim()) return;

    // Guard: Prevent duplicate submission if a request is already actively processing
    if (isSubmittingRef.current) {
      console.warn('[Copilot] Duplicate submission blocked — active request already in progress');
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    currentRequestIdRef.current = requestId;
    hasNavigatedOrSwitchedRef.current = false;
    isSubmittingRef.current = true;

    // Abort previous controller if any was lingering
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;

    console.log(`[Copilot] submit requestId=${requestId}`);

    const userMsg: CopilotMessage = { role: 'user', content: textToSend };
    addMessage(userMsg);
    if (!overrideInput) setInput('');
    setIsTyping(true);
    setStatusText('Thinking...');
    setIsStreaming(true);

    const token = localStorage.getItem('token') || 'dummy-token-for-now';
    const conversation = [...messages, userMsg];

    let currentAssistantContent = '';
    let assistantAdded = false;

    const updateLastMessage = (content: string) => {
      useCopilotStore.setState((state) => {
        const newMsgs = [...state.messages];
        if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'assistant') {
          newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], content };
        }
        return { messages: newMsgs };
      });
    };

    const appendContent = (chunk: string) => {
      currentAssistantContent += chunk;
      if (!assistantAdded) {
        addMessage({ role: 'assistant', content: currentAssistantContent });
        assistantAdded = true;
      } else {
        updateLastMessage(currentAssistantContent);
      }
    };

    try {
      const baseUrl = getApiUrl();
      await fetchEventSource(`${baseUrl}/copilot/stream`, {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'x-request-id': requestId
        },
        body: JSON.stringify({
          messages: conversation,
          tripId: tripId || undefined,
          context: JSON.stringify({
            activeRoute,
            activeView,
            draftSelections,
            documentContext
          })
        }),
        async onopen(response) {
          if (!response.ok) {
            console.error(`[Copilot] stream open failed with status ${response.status}`);
            throw new Error(`HTTP_${response.status}`);
          }
          console.log(`[Copilot] stream connected requestId=${requestId}`);
        },
        onmessage(ev) {
          // Ignore messages from older / superseded requests
          if (currentRequestIdRef.current !== requestId) return;

          try {
            const payload: CopilotResponsePayload = JSON.parse(ev.data);
            if (payload.isDone) {
              console.log(`[Copilot] stream completed requestId=${requestId}`);
              setIsTyping(false);
              setIsStreaming(false);
              isSubmittingRef.current = false;
              // If an action that switched tabs or navigated pages successfully completed, smoothly minimize Jetty
              if (hasNavigatedOrSwitchedRef.current) {
                setTimeout(() => {
                  setIsOpen(false);
                }, 750);
              }
              abortController.abort(); // Close SSE cleanly so fetchEventSource does not retry
              return;
            }
            if (payload.error) {
              console.error(`[Copilot] stream error payload requestId=${requestId}:`, payload.error);
              setIsTyping(false);
              setIsStreaming(false);
              isSubmittingRef.current = false;
              appendContent(`Error: ${payload.error}`);
              abortController.abort();
              return;
            }
            if (payload.content) {
              appendContent(payload.content);
            }
            if (payload.itineraryUpdated && payload.updatedItinerary) {
              hasNavigatedOrSwitchedRef.current = true;
              setStatusText('Updating your itinerary...');
              window.dispatchEvent(new CustomEvent('copilot-itinerary-updated', {
                detail: { updatedItinerary: payload.updatedItinerary, tripId }
              }));
              // Navigate to itinerary tab; highlight only itinerary
              const affectedTabs = payload.affectedTabs?.length ? payload.affectedTabs : ['itinerary'];
              const primaryTab = payload.primaryTab || 'itinerary';
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('switch-tab', {
                  detail: { tabId: primaryTab, affectedTabs }
                }));
              }, 300);
            }
            if (payload.tripUpdated && payload.updatedTrip) {
              hasNavigatedOrSwitchedRef.current = true;
              setStatusText('Updating your trip...');
              const updatedTrip = payload.updatedTrip;
              if (updatedTrip.id) {
                setTripId(updatedTrip.id);
              }
              const affectedTabs = payload.affectedTabs?.length ? payload.affectedTabs : ['summary'];
              const primaryTab = payload.primaryTab || 'summary';
              window.dispatchEvent(new CustomEvent('copilot-trip-updated', {
                detail: { ...payload.updatedTrip, affectedTabs, primaryTab }
              }));

              // If user is not currently on the results page for this trip, transition to ResultsDashboard!
              if (updatedTrip.id && (!pathname || !pathname.includes(updatedTrip.id))) {
                const orgParam = encodeURIComponent(updatedTrip.origin || '');
                const destParam = encodeURIComponent(updatedTrip.destination || '');
                const fromDateStr = updatedTrip.fromDate || '';
                const toDateStr = updatedTrip.toDate || '';
                const displayDates = formatDisplayDates(fromDateStr, toDateStr) || fromDateStr;
                const exactDates = fromDateStr ? `${fromDateStr}${toDateStr ? '_' + toDateStr : ''}` : '';
                const displayDatesParam = encodeURIComponent(displayDates);
                const datesParam = encodeURIComponent(exactDates);
                const currParam = (updatedTrip.currency && updatedTrip.currency !== 'USD') ? `&curr=${updatedTrip.currency}` : '';

                const resultsUrl = `/results/${updatedTrip.id}?org=${orgParam}&dest=${destParam}&dates=${datesParam}&displayDates=${displayDatesParam}${currParam}`;
                router.push(resultsUrl);
              } else {
                // Already on results page — switch to the primary affected tab
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('switch-tab', {
                    detail: { tabId: primaryTab, affectedTabs }
                  }));
                }, 600);
              }
            }
            if (payload.toolCalls && payload.toolCalls.length > 0) {
               const tool = payload.toolCalls[0];
               if (tool.function.name === 'navigate_to_page') {
                 hasNavigatedOrSwitchedRef.current = true;
                 const args = JSON.parse(tool.function.arguments || '{}');
                 if (args.path) {
                   router.push(args.path);
                   appendContent(`\n\n*Navigating to ${args.path}...*`);
                 }
               } else if (tool.function.name === 'switch_tab') {
                 hasNavigatedOrSwitchedRef.current = true;
                 const args = JSON.parse(tool.function.arguments || '{}');
                 setStatusText(`Opening ${args.tabId || 'requested'} tab...`);
                 if (args.tabId) {
                   // Use structured affectedTabs from the tool args (set by backend) or SSE payload
                   const affectedTabs = payload.affectedTabs?.length
                     ? payload.affectedTabs
                     : (args.affectedTabs?.length ? args.affectedTabs : [args.tabId]);
                   window.dispatchEvent(new CustomEvent('switch-tab', {
                     detail: { tabId: args.tabId, affectedTabs }
                   }));
                   appendContent(`\n\n*Opening ${args.tabId} tab...*`);
                 }
               } else if (tool.function.name === 'modify_trip') {
                 hasNavigatedOrSwitchedRef.current = true;
                 setStatusText('Updating your trip parameters...');
                 // Tab routing is handled by the tripUpdated payload above; no redundant switch here
               } else if (tool.function.name === 'edit_itinerary') {
                 hasNavigatedOrSwitchedRef.current = true;
                 const args = JSON.parse(tool.function.arguments || '{}');
                 setStatusText('Updating your itinerary...');
                 window.dispatchEvent(new CustomEvent('copilot-edit-itinerary', { detail: args }));
                 // Tab navigation handled by itineraryUpdated payload above
               } else {
                 setStatusText('Working on your request...');
               }
            }
          } catch (e) {
            console.error('[Copilot] Failed to parse SSE payload', e);
          }
        },
        onclose() {
          console.log(`[Copilot] stream closed requestId=${requestId}`);
          if (currentRequestIdRef.current === requestId) {
            setIsTyping(false);
            setIsStreaming(false);
            isSubmittingRef.current = false;
          }
          // Throw error on close so fetchEventSource does NOT attempt reconnection
          throw new Error('STREAM_DONE');
        },
        onerror(err) {
          if (err?.message === 'STREAM_DONE' || abortController.signal.aborted) {
            // Normal clean completion or intentional abort
            return;
          }
          console.error(`[Copilot] SSE Error requestId=${requestId}:`, err);
          if (currentRequestIdRef.current === requestId) {
            setIsTyping(false);
            setIsStreaming(false);
            isSubmittingRef.current = false;
          }
          throw err; // Stop fetchEventSource retry loop
        }
      });
    } catch (error: any) {
      if (!abortController.signal.aborted && error?.message !== 'STREAM_DONE') {
        console.error(`[Copilot] handleSend error requestId=${requestId}:`, error);
      }
      if (currentRequestIdRef.current === requestId) {
        setIsTyping(false);
        setIsStreaming(false);
        isSubmittingRef.current = false;
      }
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0 border-l-0 shadow-2xl">
        <SheetHeader className="p-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-3 text-xl">
            <JettyMascot state={jettyState} size="small" />
            <div>
              <div className="leading-none">JetSet.AI</div>
              <div className="text-xs text-muted-foreground font-normal mt-1">Personal Copilot</div>
            </div>
          </SheetTitle>
        </SheetHeader>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-muted/10 to-transparent">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full space-y-8 animate-in fade-in zoom-in duration-500">
              
              {/* Friendly Welcome Bubble */}
              <div className="flex flex-col items-center relative">
                <JettyMascot state={jettyState} size="large" className="mb-2 z-10" />
                <div className="relative bg-white text-slate-800 p-6 rounded-3xl rounded-tl-sm shadow-xl max-w-[85%] text-center -mt-4 z-0">
                  <p className="text-xl font-bold mb-2">Hey there! 💖</p>
                  <p className="text-sm">Need help planning your next adventure? <strong>I've got you!</strong></p>
                </div>
              </div>

              {/* Capabilities Sticky Note */}
              <div className="bg-amber-100 text-amber-900 p-5 rounded-md shadow-md transform rotate-2 w-3/4 self-end mr-4">
                <p className="font-bold text-sm mb-3 border-b border-amber-900/20 pb-1">I can help with:</p>
                <ul className="space-y-2 text-sm font-medium">
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Flights</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Hotels</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Itinerary</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Hidden gems</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Local tips</li>
                </ul>
              </div>

              {/* Suggested Questions */}
              <div className="w-full space-y-2 mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-2 ml-1">Suggested for you</p>
                {suggestedQuestions.map((q, idx) => (
                  <button 
                    key={idx}
                    onClick={() => handleSend(q)}
                    disabled={isTyping}
                    className="w-full text-left p-3 rounded-xl bg-muted/50 hover:bg-muted border border-transparent hover:border-sky-500/30 transition-all text-sm flex items-center gap-3 disabled:opacity-50 cursor-pointer"
                  >
                    <Navigation className="w-4 h-4 text-sky-500" />
                    {q}
                  </button>
                ))}
              </div>

            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m, i) => {
                if (m.role === 'assistant' && !m.content.trim()) return null;
                return (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start items-end gap-2'}`}>
                    {m.role === 'assistant' && (
                      <JettyMascot 
                        state={i === messages.length - 1 ? jettyState : 'idle'} 
                        size="small" 
                        className="mb-1 shrink-0" 
                      />
                    )}
                    <div className={`p-4 rounded-2xl max-w-[85%] shadow-sm ${
                      m.role === 'user' 
                        ? 'bg-sky-600 text-white rounded-br-sm' 
                        : 'bg-muted text-foreground rounded-bl-sm border border-border'
                    }`}>
                      {m.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none text-foreground select-text">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                  </div>
                );
              })}
              {isTyping && (
                <div className="flex justify-start items-end gap-2 animate-in fade-in duration-300">
                  <JettyMascot state="thinking" size="small" className="mb-1 shrink-0" />
                  <div className="p-4 rounded-2xl bg-muted rounded-bl-sm border border-border flex items-center gap-2 shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                    <span className="text-sm text-muted-foreground">Jetty is {statusText.toLowerCase()}</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="p-4 bg-background border-t shadow-xl">
          <div className="flex gap-2 relative">
            <Input 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isTyping && handleSend()}
              placeholder="Ask Jetty anything..."
              className="pr-12 py-6 rounded-full border-muted-foreground/30 focus-visible:ring-sky-500"
              disabled={isTyping}
            />
            <Button 
              size="icon"
              className="absolute right-1 top-1 h-10 w-10 rounded-full bg-sky-600 hover:bg-sky-700 cursor-pointer disabled:opacity-50" 
              onClick={() => handleSend()} 
              disabled={isTyping || !input.trim()}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
