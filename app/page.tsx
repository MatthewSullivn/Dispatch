"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { CanvasRevealEffect, MiniNavbar } from "@/components/ui/sign-in-flow-1";

/* ── Helpers ── */
function esc(str: any): string {
  if (str == null) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function renderMarkdown(md: string): string {
  const escaped = esc(md);
  return escaped.split("\n\n").map(block => {
    block = block.trim();
    if (!block) return "";
    if (/^-{3,}$|^\*{3,}$/.test(block)) return "<hr class='border-white/5 my-5'>";
    if (/^#{1,3}\s/.test(block)) {
      const m = block.match(/^(#{1,3})\s+(.*)/);
      if (!m) return `<p>${inlineMd(block)}</p>`;
      const lvl = m[1].length;
      const sizes = ["text-xl","text-lg","text-base"];
      return `<h${lvl} class="${sizes[lvl-1]} font-bold text-white/90 mt-6 mb-2">${inlineMd(m[2])}</h${lvl}>`;
    }
    if (/^[*\-]\s/.test(block)) {
      const items = block.split("\n").map(l => l.replace(/^\s*[*\-]\s+/, ""));
      return "<ul class='list-disc pl-5 my-2 space-y-1'>" + items.map(i => `<li>${inlineMd(i)}</li>`).join("") + "</ul>";
    }
    if (/^\d+\.\s/.test(block)) {
      const items = block.split("\n").map(l => l.replace(/^\s*\d+\.\s+/, ""));
      return "<ol class='list-decimal pl-5 my-2 space-y-1'>" + items.map(i => `<li>${inlineMd(i)}</li>`).join("") + "</ol>";
    }
    return `<p class="my-2">${inlineMd(block)}</p>`;
  }).join("\n");
}
function inlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="bg-white/5 px-1.5 py-0.5 rounded text-white/70 font-mono text-xs">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white/80">$1</strong>')
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-white/60 underline underline-offset-2 decoration-white/15 hover:text-white">$1</a>')
    .replace(/\n/g, "<br>");
}

function agentCls(name: string): string {
  if (!name) return "text-white/40";
  const n = name.toLowerCase();
  if (n.includes("orch")) return "text-[#ff6b6b]";
  if (n.includes("res")) return "text-[#4ecdc4]";
  if (n.includes("wri")) return "text-[#ffe66d]";
  if (n.includes("locus")) return "text-[#a78bfa]";
  return "text-white/40";
}

function agentBadgeCls(name: string): string {
  if (!name) return "";
  const n = name.toLowerCase();
  if (n.includes("orch")) return "bg-[#ff6b6b]/6 text-[#ff6b6b] border-[#ff6b6b]/8";
  if (n.includes("res")) return "bg-[#4ecdc4]/6 text-[#4ecdc4] border-[#4ecdc4]/8";
  if (n.includes("wri")) return "bg-[#ffe66d]/6 text-[#ffe66d] border-[#ffe66d]/8";
  return "bg-white/5 text-white/40 border-white/8";
}

function eventIconColor(action: string, type: string): string {
  if (type === "payment" || action?.includes("payment")) return "text-[#00d4aa]";
  if (type === "escrow" || action?.includes("escrow")) return "text-[#4ecdc4]";
  if (type === "approval" || action?.includes("approval")) return "text-[#ffe66d]";
  if (type === "api" || action?.includes("api")) return "text-[#a78bfa]";
  if (action?.includes("goal")) return "text-[#ff6b6b]";
  return "text-white/30";
}

/* ── Types ── */
interface AgentEvent {
  timestamp: string;
  agent: string;
  action: string;
  type?: string;
  amount?: number;
  provider?: string;
  endpoint?: string;
  query?: string;
  task?: string;
  serviceName?: string;
  price?: number;
  error?: string;
  sessionId?: string;
  goal?: string;
  balance?: number;
  count?: number;
  sellers?: string;
  seller?: string;
  canPay?: boolean;
  tasksCompleted?: number;
  totalSpent?: number;
  providers?: string[];
}
interface Service { serviceName: string; description: string; capabilities: string[]; agentName: string; price: number; }
interface Escrow { sessionId: string; status: string; amount: number; buyerAgent: string; sellerAgent: string; description?: string; createdAt?: string; paidAt?: string; checkoutUrl?: string; }
interface Transaction { _agent: string; to_address: string; memo: string; amount_usdc: number; status: string; tx_hash?: string; created_at: string; }
interface Approval { agent: string; amount: string; task: string; }
interface ReasonEntry { agent: string; action: string; reasoning?: string; goal?: string; task?: string; description?: string; amount?: number; }

const HIDDEN_ACTIONS = new Set([
  "escrow_failed","escrow_fallback","escrow_creating",
  "synthesis_provider_failed","payment_pending_approval","approval_required",
]);

const STEP_LABELS = [
  "Verify orchestrator wallet balance",
  "Discover agents from service registry",
  "Create escrow via Locus checkout session",
  "Worker preflight — verify escrow is valid",
  "Researcher searches via Exa + Firecrawl",
  "Release escrow — USDC payment on Base",
  "Writer synthesizes report via Gemini",
  "Release final payment — goal complete",
];
const STEP_DETAILS = ["Locus API","marketplace","lock funds","preflight","wrapped APIs","on-chain","wrapped APIs","settlement"];

/* ── Main Page ── */
export default function Home() {
  const [timeline, setTimeline] = useState<AgentEvent[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [reasoning, setReasoning] = useState<ReasonEntry[]>([]);
  const [balances, setBalances] = useState<Record<string, any>>({});
  const [walletNames, setWalletNames] = useState<Record<string, string>>({});

  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState(1.0);
  const [maxPerTask, setMaxPerTask] = useState(0.25);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [statusPhase, setStatusPhase] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [showBanner, setShowBanner] = useState(false);
  const [showStepper, setShowStepper] = useState(false);
  const [steps, setSteps] = useState<string[]>(Array(8).fill("waiting"));
  const [totalSpent, setTotalSpent] = useState(0);
  const [taskCount, setTaskCount] = useState(0);
  const [report, setReport] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [arrowsOn, setArrowsOn] = useState(false);
  const stepDone6 = useRef(false);
  const tlRef = useRef<HTMLDivElement>(null);

  /* ── Data fetching ── */
  const loadBalances = useCallback(async () => {
    try {
      const r = await fetch("/api/balances");
      const d = await r.json();
      setBalances(d.balances || {});
    } catch {}
  }, []);

  const loadServices = useCallback(async () => {
    try {
      const r = await fetch("/api/registry");
      const d = await r.json();
      setServices(d.services || []);
    } catch {}
  }, []);

  const loadEscrows = useCallback(async () => {
    try {
      const r = await fetch("/api/escrows");
      const d = await r.json();
      setEscrows(d.escrows || []);
    } catch {}
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const r = await fetch("/api/transactions");
      const d = await r.json();
      setTransactions(d.transactions || []);
    } catch {}
  }, []);

  const loadApprovals = useCallback(async () => {
    try {
      const r = await fetch("/api/approvals");
      const d = await r.json();
      setApprovals(d.approvals || []);
    } catch {}
  }, []);

  const loadReasoning = useCallback(async () => {
    try {
      const r = await fetch("/api/reasoning");
      const d = await r.json();
      setReasoning(d.reasoning || []);
    } catch {}
  }, []);

  /* ── Wallet names ── */
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/agents");
        const d = await r.json();
        const names: Record<string, string> = { "0x3c5cbe28eca3b96023c45d3f877da834f1c7d5fa": "Locus API" };
        d.agents.forEach((a: any) => {
          if (a.wallet) {
            names[a.wallet.toLowerCase()] = a.role.charAt(0).toUpperCase() + a.role.slice(1);
            names["_role_" + a.role] = a.wallet.toLowerCase();
          }
        });
        setWalletNames(names);
      } catch {}
    })();
  }, []);

  function walletLabel(addr: string): string {
    if (!addr) return "?";
    return walletNames[addr.toLowerCase()] || addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  /* ── SSE ── */
  useEffect(() => {
    const sse = new EventSource("/api/events/stream");
    sse.onmessage = (e) => {
      try {
        const ev: AgentEvent = JSON.parse(e.data);
        if (ev.action === "connected") return;
        if (!HIDDEN_ACTIONS.has(ev.action)) {
          setTimeline(prev => [...prev, ev]);
        }
        if (ev.type === "escrow") loadEscrows();
        if (ev.type === "approval") loadApprovals();
        if (ev.action?.includes("payment")) loadBalances();
        updateStepper(ev);
        updateStatus(ev);
        highlightAgent(ev);
      } catch {}
    };
    return () => sse.close();
  }, []);

  useEffect(() => {
    if (tlRef.current) tlRef.current.scrollTop = tlRef.current.scrollHeight;
  }, [timeline]);

  /* ── Initial load ── */
  useEffect(() => {
    loadBalances();
    loadServices();
    loadApprovals();
    loadEscrows();
    loadTransactions();
    const b = setInterval(loadBalances, 30000);
    const t = setInterval(loadTransactions, 60000);
    return () => { clearInterval(b); clearInterval(t); };
  }, []);

  /* ── Stepper ── */
  function updateStepper(ev: AgentEvent) {
    const a = ev.action;
    setSteps(prev => {
      const s = [...prev];
      const set = (n: number, state: string) => { if (s[n] !== "done" || state === "done") s[n] = state; };
      if (a === "balance_verified") set(0, "done");
      if (a === "agent_discovered" || a === "subtasks_planned") { set(1, "done"); set(2, "active"); }
      if (a === "escrow_created") { set(2, "done"); set(3, "active"); }
      if (a === "escrow_verified") { set(3, "done"); set(4, "active"); }
      if (a === "exa_search_completed" || a === "firecrawl_search_completed" || a === "research_completed") set(4, "done");
      if (a === "escrow_released" && !stepDone6.current) { stepDone6.current = true; set(5, "done"); set(6, "active"); }
      if (a === "synthesis_completed") set(6, "done");
      if (a === "goal_completed") set(7, "done");
      if (a === "goal_received") set(0, "active");
      if (a === "dispatching_task" && ev.task?.includes("Research")) set(4, "active");
      if (a === "dispatching_task" && ev.task?.includes("Synth")) set(6, "active");
      if (a === "payment_initiated" || a === "payment_sent" || a === "payment_completed") {
        if (stepDone6.current) set(7, "active"); else set(5, "active");
      }
      return s;
    });
  }

  /* ── Status banner ── */
  const STATUS_MAP: Record<string, { phase: string; detail: string }> = {
    goal_received: { phase: "Verifying balance", detail: "checking orchestrator wallet..." },
    balance_verified: { phase: "Planning subtasks", detail: "decomposing goal..." },
    subtasks_planned: { phase: "Discovering agents", detail: "querying service registry..." },
    agent_discovered: { phase: "Creating escrow", detail: "locking funds via Locus checkout..." },
    escrow_created: { phase: "Verifying escrow", detail: "worker preflight check..." },
    escrow_verified: { phase: "Working", detail: "" },
    dispatching_task: { phase: "Working", detail: "" },
    research_started: { phase: "Researching", detail: "searching via Exa + Firecrawl..." },
    research_completed: { phase: "Releasing payment", detail: "research delivered, paying researcher..." },
    escrow_released: { phase: "Payment released", detail: "USDC transferred on Base" },
    synthesis_started: { phase: "Synthesizing", detail: "generating report via LLM..." },
    synthesis_completed: { phase: "Releasing payment", detail: "report delivered, paying writer..." },
    payment_completed: { phase: "Payment confirmed", detail: "on-chain USDC transfer complete" },
    goal_completed: { phase: "Complete", detail: "all tasks finished" },
  };

  function updateStatus(ev: AgentEvent) {
    const cfg = STATUS_MAP[ev.action];
    if (!cfg) return;
    setShowBanner(true);
    setStatusPhase(cfg.phase);
    if (ev.action === "dispatching_task") {
      setStatusDetail(ev.task?.includes("Research") ? "dispatching to researcher..." : "dispatching to writer...");
    } else {
      setStatusDetail(cfg.detail);
    }
    if (ev.action === "goal_completed") {
      setTimeout(() => setShowBanner(false), 8000);
    }
  }

  function highlightAgent(ev: AgentEvent) {
    const name = (ev.agent || "").toLowerCase();
    let id = "";
    if (name.includes("orch")) id = "orchestrator";
    else if (name.includes("res")) id = "researcher";
    else if (name.includes("wri")) id = "writer";
    if (!id) return;
    setActiveAgents(prev => new Set(prev).add(id));
    setTimeout(() => setActiveAgents(prev => { const s = new Set(prev); s.delete(id); return s; }), 3000);
  }

  /* ── Run goal ── */
  async function runGoal() {
    if (!goal.trim() || running) return;
    setRunning(true);
    setStatus("running");
    setShowBanner(true);
    setStatusPhase("Starting");
    setStatusDetail("submitting goal to orchestrator...");
    setShowStepper(true);
    setReport("");
    setReportLoading(true);
    setTimeline([]);
    setArrowsOn(true);
    stepDone6.current = false;
    setSteps(Array(8).fill("waiting"));

    try {
      const r = await fetch("/api/goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goal.trim(), budget, maxPerTask }),
      });
      const data = await r.json();
      if (data.success) {
        const s = data.audit?.summary;
        if (s) { setTotalSpent(s.totalSpent || 0); setTaskCount(s.completed || 0); }
        let rpt = data.report?.report || "No report generated.";
        try { const p = JSON.parse(rpt); rpt = p?.data?.choices?.[0]?.message?.content || p?.choices?.[0]?.message?.content || rpt; } catch {}
        setReport(rpt);
        setStatus("done");
      } else {
        setReport(data.error || "Failed");
        setStatus("error");
      }
    } catch (err: any) {
      setReport(err.message);
      setStatus("error");
    }

    setRunning(false);
    setReportLoading(false);
    setArrowsOn(false);
    setActiveAgents(new Set());
    loadBalances();
    loadEscrows();
    loadApprovals();
    loadReasoning();
    setTimeout(loadTransactions, 3000);
  }

  const agents = [
    { id: "orchestrator", key: "o", name: "Orchestrator", role: "Discovers, budgets, pays", dotColor: "bg-[#ff6b6b]", glowColor: "#ff6b6b" },
    { id: "researcher", key: "r", name: "Researcher", role: "Search + scrape via Locus", dotColor: "bg-[#4ecdc4]", glowColor: "#4ecdc4" },
    { id: "writer", key: "w", name: "Writer", role: "Synthesize via Locus LLMs", dotColor: "bg-[#ffe66d]", glowColor: "#ffe66d" },
  ];

  const exampleChips = ["Top DeFi protocols on Base", "Locus vs traditional payment APIs", "What is ERC-8004?", "AI agent infrastructure trends"];

  return (
    <div className="flex w-full flex-col min-h-screen bg-black relative text-white/60">
      {/* Dot matrix background */}
      <div className="fixed inset-0 z-0">
        <CanvasRevealEffect
          animationSpeed={3}
          containerClassName="bg-black"
          colors={[[255, 255, 255], [255, 255, 255]]}
          dotSize={6}
          reverse={false}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,0.8)_0%,_transparent_100%)]" />
        <div className="absolute top-0 left-0 right-0 h-[30%] bg-gradient-to-b from-black to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-[20%] bg-gradient-to-t from-black to-transparent" />
      </div>

      {/* Navbar */}
      <MiniNavbar />

      {/* Content */}
      <div className="relative z-10 w-full max-w-[980px] mx-auto px-6 before:content-[''] before:absolute before:inset-0 before:-mx-12 before:bg-black/80 before:backdrop-blur-sm before:-z-10 before:rounded-3xl">

        {/* ── Hero ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center pt-28 pb-10"
        >
          <h1 className="text-7xl font-black tracking-[-4px] leading-[0.9] text-white">
            Dispatch
          </h1>
          <p className="text-[17px] text-white/60 mt-5 leading-relaxed font-normal max-w-[520px] mx-auto">
            Autonomous AI agents that discover, hire, and pay each other in USDC on Base.
          </p>
          <div className="flex justify-center gap-2 mt-7">
            {["Locus", "Base", "USDC"].map(b => (
              <span key={b} className="font-mono text-[10px] px-3.5 py-1.5 rounded-full font-semibold tracking-wider uppercase bg-white/10 text-white/60 border border-white/15">
                {b}
              </span>
            ))}
          </div>
        </motion.div>

        {/* ── Goal Input ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="max-w-[720px] mx-auto mb-14 text-center"
        >
          <div className="flex gap-1.5 flex-wrap justify-center mb-4">
            {exampleChips.map(chip => (
              <button key={chip} onClick={() => setGoal(chip)} className="text-[11px] text-white/50 bg-white/5 border border-white/12 rounded-full px-3.5 py-1.5 cursor-pointer transition-all hover:border-white/25 hover:text-white/80 font-medium">
                {chip}
              </button>
            ))}
          </div>
          <div className="flex gap-2 bg-white/8 border border-white/15 rounded-full p-1.5 pl-6 items-center transition-colors focus-within:border-white/30">
            <input
              type="text"
              value={goal}
              onChange={e => setGoal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && runGoal()}
              maxLength={500}
              placeholder="Give Dispatch a goal..."
              className="flex-1 bg-transparent border-none py-2.5 text-white/90 text-[15px] font-normal outline-none placeholder:text-white/35"
            />
            <button
              onClick={runGoal}
              disabled={running}
              className="relative bg-white text-black border-none rounded-full px-7 py-3 font-bold text-[13px] tracking-wide uppercase whitespace-nowrap shrink-0 cursor-pointer transition-all hover:bg-white/85 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-15 disabled:cursor-not-allowed group"
            >
              <div className="absolute inset-[-6px] rounded-full bg-white/8 blur-[16px] opacity-0 group-hover:opacity-100 transition-opacity -z-10" />
              {running ? "RUNNING..." : "RUN DISPATCH"}
            </button>
          </div>
          <div className="flex gap-6 mt-3 justify-center text-xs text-white/50 font-medium">
            <span>Budget <input type="number" value={budget} onChange={e => setBudget(parseFloat(e.target.value) || 1)} min={0.1} step={0.25} className="w-[60px] bg-transparent border border-white/15 rounded-full px-2.5 py-1 text-white/80 font-mono text-[11px] outline-none text-center focus:border-white/35 mx-1" /> USDC</span>
            <span>Max per task <input type="number" value={maxPerTask} onChange={e => setMaxPerTask(parseFloat(e.target.value) || 0.25)} min={0.05} step={0.05} className="w-[60px] bg-transparent border border-white/15 rounded-full px-2.5 py-1 text-white/80 font-mono text-[11px] outline-none text-center focus:border-white/35 mx-1" /> USDC</span>
          </div>
        </motion.div>

        {/* ── Status Banner ── */}
        {showBanner && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2.5 px-5 py-2.5 rounded-full bg-white/6 border border-white/10 mb-6 text-xs text-white/60">
            <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shrink-0" />
            <span className="text-white font-bold">{statusPhase}</span> {statusDetail}
          </motion.div>
        )}

        {/* ── Stats ── */}
        <div className="flex justify-center mb-8 text-xs">
          {[
            { label: "Status", value: status },
            { label: "Budget", value: running ? `$${budget.toFixed(2)}` : "--" },
            { label: "Spent", value: `$${totalSpent.toFixed(2)}`, red: true },
            { label: "Tasks", value: String(taskCount) },
            { label: "Escrows", value: String(escrows.length) },
          ].map((s, i) => (
            <div key={s.label} className={`flex gap-1.5 items-center px-5 ${i < 4 ? "border-r border-white/6" : ""}`}>
              <span className="text-white/45 text-[10px] font-semibold uppercase tracking-widest">{s.label}</span>
              <span className={`font-mono font-bold text-xs ${s.red ? "text-[#ff6b6b]" : "text-white/80"}`}>{s.value}</span>
            </div>
          ))}
        </div>

        {/* ── Agent Network ── */}
        <div className="mb-12">
          <div className="font-mono text-[10px] text-white/35 uppercase tracking-[3px] mb-5 text-center font-semibold">Agent Network</div>
          <div className="flex items-center justify-center">
            {agents.map((agent, i) => (
              <React.Fragment key={agent.id}>
                <div className={`bg-white/8 border rounded-2xl p-6 min-w-[190px] text-center transition-all duration-400 relative overflow-hidden ${activeAgents.has(agent.id) ? "border-white/30" : "border-white/12 hover:border-white/20 hover:bg-white/10"} ${running ? "border-white/20 shadow-[0_0_40px_rgba(255,255,255,0.06)]" : ""}`}>
                  <div className="absolute top-0 left-[20%] right-[20%] h-px opacity-0 hover:opacity-100 transition-opacity" style={{ background: `linear-gradient(90deg, transparent, ${agent.glowColor}, transparent)` }} />
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${agent.dotColor} ${activeAgents.has(agent.id) ? "animate-pulse" : ""}`} />
                    <span className="text-sm font-bold text-white/90">{agent.name}</span>
                  </div>
                  <div className="text-[11px] text-white/55 mt-1">{agent.role}</div>
                  <div className="font-mono text-[15px] font-bold mt-3 text-white">
                    {balances[agent.id]?.usdc_balance ? `${parseFloat(balances[agent.id].usdc_balance).toFixed(2)} USDC` : "--"}
                  </div>
                  {balances[agent.id]?.wallet_address && (
                    <div className="font-mono text-[9px] text-white/30 mt-1">
                      <a href={`https://basescan.org/address/${balances[agent.id].wallet_address}`} target="_blank" rel="noopener" className="text-white/30 no-underline hover:text-white/60 transition-colors">
                        {balances[agent.id].wallet_address.slice(0, 6)}...{balances[agent.id].wallet_address.slice(-4)}
                      </a>
                    </div>
                  )}
                </div>
                {i < 2 && (
                  <div className="px-3 text-center">
                    <div className={`w-10 h-px mx-auto relative ${arrowsOn ? "bg-white/30" : "bg-white/12"}`}>
                      <span className={`absolute right-[-4px] top-[-2px] w-0 h-0 border-l-[5px] border-t-[3px] border-b-[3px] border-t-transparent border-b-transparent ${arrowsOn ? "border-l-white/40" : "border-l-white/20"}`} />
                    </div>
                    <span className={`font-mono text-[8px] font-semibold tracking-widest uppercase mt-1 block ${arrowsOn ? "text-white/50" : "text-white/25"}`}>USDC</span>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* ── Stepper ── */}
        {showStepper && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-8 bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="text-[10px] uppercase tracking-[3px] font-bold text-white/40 mb-3.5">Payment Flow</div>
            {STEP_LABELS.map((label, i) => {
              const state = steps[i];
              return (
                <div key={i} className={`flex items-center gap-3 py-2 ${i < 7 ? "border-b border-white/5" : ""}`}>
                  <div className={`w-[22px] h-[22px] rounded-full flex items-center justify-center font-mono text-[9px] font-bold shrink-0 transition-all ${
                    state === "done" ? "bg-[#00d4aa]/15 border border-[#00d4aa]/25 text-[#00d4aa]" :
                    state === "active" ? "bg-white/15 border border-white/30 text-white animate-pulse" :
                    state === "error" ? "bg-[#ff6b6b]/15 border border-[#ff6b6b]/25 text-[#ff6b6b]" :
                    "bg-white/5 border border-white/10 text-white/30"
                  }`}>
                    {state === "done" ? "ok" : state === "error" ? "!" : i + 1}
                  </div>
                  <span className={`text-xs font-medium transition-colors ${state === "active" ? "text-white/90" : state === "done" ? "text-white/40" : "text-white/45"}`}>{label}</span>
                  <span className={`ml-auto font-mono text-[9px] ${state === "active" ? "text-white/60" : state === "done" ? "text-white/30" : "text-white/25"}`}>{STEP_DETAILS[i]}</span>
                </div>
              );
            })}
          </motion.div>
        )}

        {/* ── Panels ── */}
        <div className="grid grid-cols-2 gap-3 mb-12 max-md:grid-cols-1">
          {/* Timeline - full width */}
          <Panel title="Live Timeline" count={timeline.length} full>
            <div ref={tlRef} className="max-h-[380px] overflow-y-auto space-y-0 scrollbar-thin">
              {timeline.length === 0 ? <Empty>run a goal to see real-time agent activity</Empty> :
                timeline.map((ev, i) => (
                  <div key={i} className="flex gap-2 py-[5px] items-baseline text-[11px] border-b border-white/[0.025] last:border-none animate-[slideIn_0.2s_ease]">
                    <span className={`text-[6px] min-w-[10px] ${eventIconColor(ev.action, ev.type || "")}`}>&bull;</span>
                    <span className="font-mono text-white/30 text-[9px] min-w-[58px] font-medium">{new Date(ev.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                    <span className={`font-bold min-w-[85px] text-[10px] ${agentCls(ev.agent)}`}>{ev.agent || "mesh"}</span>
                    <span className="font-mono text-white/45 text-[10px]">{ev.action}</span>
                    <span className="text-white/60 text-[11px]">
                      {ev.amount ? `${ev.amount} USDC` : ev.provider ? `${ev.provider}/${ev.endpoint}` : ev.query ? ev.query?.slice(0, 50) : ev.task ? ev.task?.slice(0, 50) : ev.serviceName ? `${ev.serviceName} @ $${ev.price}` : ev.error ? ev.error?.slice(0, 80) : ev.sessionId ? `session:${ev.sessionId?.slice(0, 8)}` : ""}
                    </span>
                  </div>
                ))
              }
            </div>
          </Panel>

          {/* Marketplace */}
          <Panel title="Marketplace" count={services.length}>
            {services.length === 0 ? <Empty>loading services...</Empty> :
              services.map((s, i) => (
                <div key={i} className="flex items-center gap-3 p-3.5 bg-white/5 border border-white/8 rounded-xl mb-2 transition-all hover:border-white/15">
                  <div>
                    <div className="text-[13px] font-bold text-white/90">{s.serviceName}</div>
                    <div className="text-[11px] text-white/55 mt-0.5">{s.description.slice(0, 90)}</div>
                    <div className="flex gap-1 mt-1">{(s.capabilities || []).map(c => <span key={c} className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/8 border border-white/12 text-white/60 font-mono font-medium">{c}</span>)}</div>
                    <div className="font-mono text-[10px] text-white/45 mt-1">{s.agentName}</div>
                  </div>
                  <div className="ml-auto font-mono text-base font-bold text-white whitespace-nowrap">${s.price.toFixed(2)}</div>
                </div>
              ))
            }
          </Panel>

          {/* Escrow */}
          <Panel title="Escrow Sessions" count={escrows.length}>
            {escrows.length === 0 ? <Empty>no escrows yet</Empty> :
              escrows.map((e, i) => {
                const stCls = e.status.includes("release") ? "bg-[#00d4aa]/6 text-[#00d4aa] border-[#00d4aa]/10" : e.status.includes("fail") ? "bg-[#ff6b6b]/6 text-[#ff6b6b] border-[#ff6b6b]/10" : "bg-[#ffe66d]/6 text-[#ffe66d] border-[#ffe66d]/10";
                return (
                  <div key={i} className="p-3.5 bg-white/5 border border-white/8 rounded-xl mb-2.5 text-[11px] transition-colors hover:border-white/15">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold font-mono tracking-wide uppercase border ${stCls}`}>{e.status}</span>
                      <span className="ml-auto font-mono text-[15px] font-bold text-white">${String(e.amount)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="text-[10px] font-bold font-mono text-[#ff6b6b]">{e.buyerAgent}</span>
                      <span className="text-white/30 text-[10px]">&rarr;</span>
                      <span className="text-[10px] font-bold font-mono text-[#4ecdc4]">{e.sellerAgent}</span>
                    </div>
                    {e.description && <div className="text-white/60 text-[10px] mb-2">{e.description}</div>}
                  </div>
                );
              })
            }
          </Panel>

          {/* Transactions - full width */}
          <Panel title="On-Chain Transactions" count={transactions.length} full>
            {transactions.length === 0 ? <Empty>loading transactions...</Empty> :
              transactions.map((tx, i) => (
                <div key={i} className={`flex items-center gap-2.5 px-3 py-2.5 border border-white/3 rounded-[10px] mb-1 text-[11px] transition-all hover:border-white/7 ${i % 2 === 0 ? "bg-white/[0.015]" : "bg-white/[0.008]"}`}>
                  <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold min-w-[54px] text-center border ${agentBadgeCls(tx._agent)}`}>{tx._agent}</span>
                  <span className="text-white/15 text-[9px] font-mono">{new Date(tx.created_at).toLocaleTimeString("en-US", { hour12: false })}</span>
                  <span className="text-white/25 text-[9px]">&rarr; {walletLabel(tx.to_address)}</span>
                  <span className="text-white/35 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{tx.memo || "Transfer"}</span>
                  <span className="font-mono font-bold text-white whitespace-nowrap">${parseFloat(String(tx.amount_usdc || 0)).toFixed(2)}</span>
                  <span className={`text-[8px] font-mono px-2 py-0.5 rounded-full font-bold tracking-wide uppercase border ${tx.status?.toLowerCase().includes("confirm") ? "bg-[#00d4aa]/6 text-[#00d4aa] border-[#00d4aa]/8" : tx.status?.toLowerCase().includes("queue") ? "bg-[#ffe66d]/6 text-[#ffe66d] border-[#ffe66d]/8" : "bg-[#ff6b6b]/6 text-[#ff6b6b] border-[#ff6b6b]/8"}`}>{tx.status}</span>
                  {tx.tx_hash && <a href={`https://basescan.org/tx/${tx.tx_hash}`} target="_blank" rel="noopener" className="font-mono text-[9px] text-white/20 no-underline hover:text-white/50">{tx.tx_hash.slice(0, 10)}...</a>}
                </div>
              ))
            }
          </Panel>

          {/* Report - full width */}
          <Panel title="Report Output" full>
            {reportLoading ? (
              <div className="text-white/15 text-center py-6 text-[11px] font-medium animate-pulse">agents are researching and synthesizing...</div>
            ) : report ? (
              <div className="text-sm leading-relaxed text-white/50 prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }} />
            ) : (
              <Empty>submit a goal to see the synthesized report</Empty>
            )}
          </Panel>

          {/* Spending Controls */}
          <Panel title="Spending Controls" count={approvals.length}>
            {approvals.length === 0 ? <Empty>no payments flagged</Empty> : <>
              <div className="text-[11px] text-white/35 pb-2.5 leading-relaxed">Locus spending controls held these payments for review.</div>
              {approvals.map((a, i) => (
                <div key={i} className="p-3.5 bg-white/2 border border-white/4 rounded-xl mb-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-white/50 font-semibold">{a.agent}</span>
                    <span className="font-mono text-[15px] text-[#ffe66d] font-bold">${a.amount}</span>
                  </div>
                  <div className="text-[11px] text-white/35 mt-1">{a.task}</div>
                  <div className="text-[9px] text-white/20 mt-1.5 font-semibold uppercase tracking-wide">Held by Locus</div>
                </div>
              ))}
            </>}
          </Panel>

          {/* Reasoning */}
          <Panel title="Agent Reasoning" count={reasoning.length}>
            {reasoning.length === 0 ? <Empty>run a goal to see agent reasoning</Empty> :
              reasoning.map((ev, i) => (
                <div key={i} className="flex gap-2 py-1.5 items-baseline text-[11px] border-b border-white/[0.025] last:border-none">
                  <span className={`font-bold min-w-[75px] text-[10px] ${agentCls(ev.agent)}`}>{ev.agent || "mesh"}</span>
                  <span className="font-mono text-[9px] text-white/20 min-w-[90px]">{ev.action}</span>
                  <span className="text-white/40 text-[11px] leading-snug">
                    {ev.reasoning || ev.goal || ev.task || ev.description || ""}
                    {ev.amount ? <span className="text-white font-mono font-bold ml-1">${ev.amount} USDC</span> : null}
                  </span>
                </div>
              ))
            }
          </Panel>
        </div>

        {/* ── Divider ── */}
        <div className="h-px bg-gradient-to-r from-transparent via-white/6 to-transparent my-14" />

        {/* ── About ── */}
        <FadeIn>
          <div id="about" className="grid grid-cols-3 gap-px mb-14 bg-white/8 rounded-2xl overflow-hidden max-md:grid-cols-1">
            {[
              { title: "How it works", text: "Give a goal to the orchestrator. It discovers agents, escrows USDC via Locus, dispatches work, and releases payment on delivery. Every dollar tracked on-chain." },
              { title: "Why it matters", text: "AI agents can think and act, but can't safely pay each other. Dispatch gives every agent its own Locus wallet with spending controls, making autonomous coordination real." },
              { title: "Safety first", text: "Rate limiting, budget caps, Locus spending controls, checkout escrow, and full audit trails with agent reasoning logs. Every decision is explainable." },
            ].map(card => (
              <div key={card.title} className="bg-black/90 p-7">
                <h3 className="text-[13px] font-bold text-white/90 mb-2">{card.title}</h3>
                <p className="text-[13px] text-white/60 leading-relaxed">{card.text}</p>
              </div>
            ))}
          </div>
        </FadeIn>

        {/* ── Locus Integration ── */}
        <FadeIn>
          <div id="locus" className="mb-14">
            <div className="font-mono text-[10px] text-white/35 uppercase tracking-[3px] mb-5 text-center font-semibold">Locus Integration</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-px bg-white/8 rounded-xl overflow-hidden">
              {[
                { name: "Agent Wallets", desc: "3 autonomous Locus wallets on Base. Agents hold, send, and receive USDC independently.", tag: "core" },
                { name: "Checkout Session Escrow", desc: "Funds locked via checkout sessions. Worker preflight verifies. Payment released on delivery.", tag: "bonus" },
                { name: "Pay-Per-Use Wrapped APIs", desc: "Exa, Firecrawl, Gemini, Grok through Locus. Each call billed in USDC.", tag: "bonus" },
                { name: "Spending Controls", desc: "Approval thresholds and allowance caps. Payments above threshold require human approval.", tag: "bonus" },
                { name: "On-Chain Auditability", desc: "Every payment is a real USDC transfer on Base, verifiable on BaseScan.", tag: "bonus" },
                { name: "Email Escrow Fallback", desc: "If checkout escrow fails, agents fall back to Locus email escrow.", tag: "bonus" },
                { name: "Self-Registering Wallets", desc: "Agents self-register via Locus API. Setup script handles wallet deployment.", tag: "required" },
                { name: "Checkout Webhooks", desc: "Real-time webhook notifications from Locus on escrow status changes. Drives live dashboard updates via SSE.", tag: "bonus" },
                { name: "Direct Wallet Payments", desc: "Agent-to-agent USDC transfers via Locus sendPayment. Falls back from escrow when checkout sessions are unavailable.", tag: "core" },
              ].map(f => (
                <div key={f.name} className="bg-black/90 p-4">
                  <div className="font-mono text-[10px] text-[#00d4aa] font-bold mb-1">[x]</div>
                  <div className="text-[13px] font-bold text-white/85 mb-1">{f.name}</div>
                  <div className="text-[11px] text-white/55 leading-relaxed">{f.desc}</div>
                  <span className="inline-block mt-1.5 text-[8px] font-mono px-2 py-0.5 rounded-full font-bold tracking-wide uppercase bg-white/10 text-white/60 border border-white/15">{f.tag}</span>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>

        {/* ── Vision ── */}
        <FadeIn>
          <div id="vision" className="mb-14 text-center py-16 px-8">
            <h2 className="text-[32px] font-black text-white tracking-[-1.5px] mb-2">The future of agent commerce</h2>
            <div className="text-sm text-white/50 mb-6">From hackathon prototype to autonomous agent economy</div>
            <p className="text-[15px] text-white/60 leading-relaxed max-w-[640px] mx-auto mb-10">
              Dispatch proves AI agents can discover, hire, and pay each other without human intervention. Every payment is real USDC on Base. Every decision is auditable. This isn&apos;t a simulation.
            </p>
            <div className="grid grid-cols-3 gap-px mb-10 text-left bg-white/8 rounded-2xl overflow-hidden max-md:grid-cols-1">
              {[
                { icon: "◆", title: "Agent Marketplace", desc: "Deploy an agent, register a service, start earning USDC. The orchestrator discovers and hires automatically.", tag: "working today", tagCls: "bg-[#00d4aa]/10 text-[#00d4aa] border-[#00d4aa]/15" },
                { icon: "◇", title: "Escrow-First Payments", desc: "Funds locked before work starts. Workers verify via preflight. Payment releases only on delivery.", tag: "working today", tagCls: "bg-[#00d4aa]/10 text-[#00d4aa] border-[#00d4aa]/15" },
                { icon: "◊", title: "Pay-Per-Use Intelligence", desc: "Agents call search, scraping, and LLM APIs through Locus. Pay per call in USDC. Costs on-chain.", tag: "working today", tagCls: "bg-[#00d4aa]/10 text-[#00d4aa] border-[#00d4aa]/15" },
                { icon: "△", title: "Competitive Bidding", desc: "Multiple agents, same capability, different prices. Market competition drives quality up and cost down.", tag: "next milestone", tagCls: "bg-white/6 text-white/50 border-white/10" },
                { icon: "▵", title: "Reputation Scoring", desc: "Track completion rates and quality on-chain. Orchestrators factor reputation into hiring decisions.", tag: "next milestone", tagCls: "bg-white/6 text-white/50 border-white/10" },
                { icon: "○", title: "Cross-Network Federation", desc: "Agents from different networks discover and transact. Locus wallets bridge them seamlessly.", tag: "future vision", tagCls: "bg-white/4 text-white/35 border-white/8" },
              ].map(c => (
                <div key={c.title} className="p-5 bg-black/90">
                  <div className="text-base mb-2 opacity-50">{c.icon}</div>
                  <h3 className="text-[13px] font-bold text-white/90 mb-1">{c.title}</h3>
                  <p className="text-[11px] text-white/55 leading-relaxed m-0">{c.desc}</p>
                  <span className={`inline-block mt-2 text-[8px] font-bold px-2 py-0.5 rounded-full font-mono tracking-wide uppercase border ${c.tagCls}`}>{c.tag}</span>
                </div>
              ))}
            </div>

            <div className="w-8 h-px bg-white/8 mx-auto mb-6" />
            <div className="text-base italic text-white/60 max-w-[560px] mx-auto mb-1.5 leading-relaxed">
              &ldquo;The next billion-dollar company will have <span className="text-white font-bold not-italic">no employees</span> — just AI agents with wallets, discovering work and getting paid.&rdquo;
            </div>
            <div className="text-[10px] text-white/30 mb-9">— The thesis behind Dispatch</div>

            <div className="flex justify-center gap-14">
              {[
                { num: "3", label: "Wallets" },
                { num: "4", label: "Wrapped APIs" },
                { num: "9", label: "Locus Features" },
                { num: "100%", label: "On-Chain" },
              ].map(s => (
                <div key={s.label}>
                  <div className="font-mono text-[28px] font-black text-white">{s.num}</div>
                  <div className="text-[9px] text-white/45 uppercase tracking-[1.5px] font-semibold mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>

        {/* ── Footer ── */}
        <div className="text-center py-10 text-[11px] text-white/30 font-medium border-t border-white/8">
          Dispatch &middot; Built for{" "}
          <a href="https://synthesis.md" target="_blank" className="text-white/40 no-underline hover:text-white/70 transition-colors">The Synthesis</a>
          {" "}&middot; Powered by{" "}
          <a href="https://paywithlocus.com" target="_blank" className="text-white/40 no-underline hover:text-white/70 transition-colors">Locus</a>
          {" "}on{" "}
          <a href="https://base.org" target="_blank" className="text-white/40 no-underline hover:text-white/70 transition-colors">Base</a>
        </div>
      </div>
    </div>
  );
}

/* ── Reusable components ── */
function Panel({ title, count, full, children }: { title: string; count?: number; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`bg-white/[0.05] border border-white/12 rounded-2xl overflow-hidden transition-colors hover:border-white/20 ${full ? "col-span-full" : ""}`}>
      <div className="px-4 py-3 text-[10px] uppercase tracking-[2px] border-b border-white/10 font-bold flex items-center gap-2 text-white/60">
        {title}
        {count !== undefined && (
          <span className="bg-white/10 px-2 py-0.5 rounded-full text-[10px] font-mono text-white/50">{count}</span>
        )}
      </div>
      <div className="p-3 max-h-[380px] overflow-y-auto text-xs leading-relaxed scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/15">
        {children}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-white/40 text-center py-6 text-[11px] font-medium">{children}</div>;
}

function FadeIn({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setVisible(true); }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={`transition-all duration-700 ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5"}`}>
      {children}
    </div>
  );
}
