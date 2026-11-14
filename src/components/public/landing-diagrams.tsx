import * as React from "react";
import { BookOpen, Bot, CalendarCheck, Check, ListChecks, LockKeyhole, ShieldCheck, Smartphone, type LucideIcon } from "lucide-react";

// Explanatory diagrams for the public front door (docs/design/public-front-door.md, "Diagrams").
// Server-rendered and complete without JavaScript: every label, step and caption is in the
// markup. The moving pulses are decoration that public.css runs only while LandingMotion says
// motion is on and the figure is in view; reduced motion, forced colours and the pause control
// leave the still picture. Examples only: no logos, no live data, no controls.

// Custom properties feed the timings and counts in public.css.
const vars = (values: Record<`--${string}`, string>) => values as React.CSSProperties;

const AGENTS = ["Claude", "ChatGPT", "Gemini", "Grok", "Llama"] as const;
const SERVICES = ["Outlook", "Gmail", "Notion", "Drive", "Calendar"] as const;

// One drawing grid for both pictures: agents on the left, services on the right.
// 340 units keeps the 17-unit labels at 12px or more on a 320px screen (public.css).
const VIEW_W = 340;
const VIEW_H = 312;
const PILL_W = 96;
const PILL_H = 36;
const LEFT_X = 2;
const RIGHT_X = VIEW_W - 2 - PILL_W;
const ROW = (i: number) => 44 + i * 60;
const HUB = { x: VIEW_W / 2, y: ROW(2), r: 40 };
// Pulses reach the hub 1.1s after leaving an agent, one request every 1.2s (a 6s cycle).
const RELAY_STEP = 1.2;

function Pill({ label, x, y }: { label: string; x: number; y: number }) {
  return (
    <g className="wh-diagram-node">
      <rect x={x} y={y - PILL_H / 2} width={PILL_W} height={PILL_H} rx={PILL_H / 2} />
      <text x={x + PILL_W / 2} y={y} textAnchor="middle" dominantBaseline="central">{label}</text>
    </g>
  );
}

function Pills() {
  return (
    <>
      {AGENTS.map((agent, i) => <Pill key={agent} label={agent} x={LEFT_X} y={ROW(i)} />)}
      {SERVICES.map((service, j) => <Pill key={service} label={service} x={RIGHT_X} y={ROW(j)} />)}
    </>
  );
}

// Every agent wired straight to every service: 25 lines, each with its own pulse at its own
// uneven pace, so the picture reads as busy as the set-up it stands for.
function WithoutWarthog() {
  const wires = AGENTS.flatMap((_, i) => SERVICES.map((__, j) => {
    const duration = 1.7 + ((i * 7 + j * 3) % 10) * 0.16;
    return {
      key: `${i}-${j}`,
      d: `M${LEFT_X + PILL_W},${ROW(i)} L${RIGHT_X},${ROW(j)}`,
      style: vars({
        "--wh-pulse-duration": `${duration.toFixed(2)}s`,
        "--wh-pulse-delay": `${(-(((i * 5 + j * 11) % 17) / 17) * duration).toFixed(2)}s`,
      }),
    };
  }));
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Five agents, each connected separately to five services: 25 crossing lines." focusable="false">
      {wires.map((wire) => <path key={wire.key} className="wh-diagram-wire" d={wire.d} data-wire="" />)}
      {wires.map((wire) => <path key={wire.key} className="wh-diagram-pulse" d={wire.d} pathLength={100} style={wire.style} />)}
      <Pills />
    </svg>
  );
}

// Agents connect to Warthog and Warthog connects to the services: 10 lines. Requests take
// turns: agent i's pulse reaches Warthog, the ring marks the check, then it leaves for
// service (i + 2) mod 5.
function WithWarthog() {
  const inbound = AGENTS.map((_, i) => {
    const [x0, x1] = [LEFT_X + PILL_W, HUB.x - HUB.r];
    return { key: `in-${i}`, d: `M${x0},${ROW(i)} C${x0 + 16},${ROW(i)} ${x1 - 16},${HUB.y} ${x1},${HUB.y}`, delay: i * RELAY_STEP };
  });
  const outbound = SERVICES.map((_, j) => {
    const [x0, x1] = [HUB.x + HUB.r, RIGHT_X];
    return { key: `out-${j}`, d: `M${x0},${HUB.y} C${x0 + 16},${HUB.y} ${x1 - 16},${ROW(j)} ${x1},${ROW(j)}`, delay: ((j + 3) % 5) * RELAY_STEP + 1.3 };
  });
  const wires = [...inbound, ...outbound];
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Five agents connect to Warthog, and Warthog connects to five services: 10 lines." focusable="false">
      {wires.map((wire) => <path key={wire.key} className="wh-diagram-wire" d={wire.d} data-wire="" />)}
      {wires.map((wire) => (
        <path key={wire.key} className="wh-diagram-pulse" d={wire.d} pathLength={100} style={vars({ "--wh-pulse-delay": `${wire.delay.toFixed(1)}s` })} />
      ))}
      <circle className="wh-diagram-ring" cx={HUB.x} cy={HUB.y} r={HUB.r} />
      <circle className="wh-diagram-hub" cx={HUB.x} cy={HUB.y} r={HUB.r} />
      <text className="wh-diagram-hub-label" x={HUB.x} y={HUB.y} textAnchor="middle" dominantBaseline="central">Warthog</text>
      <Pills />
    </svg>
  );
}

export function ConnectOnceDiagrams() {
  return (
    <div className="wh-diagram-pair">
      <figure className="wh-diagram wh-diagram-without" aria-labelledby="diagram-without-title" data-motion-surface>
        <div className="wh-diagram-head">
          <h3 id="diagram-without-title">Without Warthog</h3>
          <span className="wh-diagram-count">25 separate connections</span>
        </div>
        <div className="wh-diagram-columns" aria-hidden="true"><span>Agents</span><span>Services</span></div>
        <WithoutWarthog />
        <figcaption>Each agent signs in to each service on its own. A new agent means connecting every service again.</figcaption>
      </figure>
      <figure className="wh-diagram wh-diagram-with" aria-labelledby="diagram-with-title" data-motion-surface>
        <div className="wh-diagram-head">
          <h3 id="diagram-with-title">With Warthog</h3>
          <span className="wh-diagram-count">10 connections, one place</span>
        </div>
        <div className="wh-diagram-columns" aria-hidden="true"><span>Agents</span><span>Services</span></div>
        <WithWarthog />
        <figcaption>Each service connects once. Each agent connects only to Warthog, which checks every request against what you allowed.</figcaption>
      </figure>
    </div>
  );
}

type FlowStep = {
  icon: LucideIcon;
  title: string;
  detail: string;
  // Seconds into the cycle when the pulse reaches this step (public.css plays the cycle).
  at: number;
  status?: { label: string; at: number };
  buzz?: boolean;
};

function Flow({ id, title, note, cycle, steps, aside }: {
  id: string;
  title: string;
  note: string;
  cycle: number;
  steps: readonly FlowStep[];
  aside?: React.ReactNode;
}) {
  return (
    <figure className="wh-flow" aria-labelledby={`${id}-title`} data-motion-surface style={vars({ "--wh-flow-cycle": `${cycle}s` })}>
      <div className="wh-flow-head">
        <h3 id={`${id}-title`}>{title}</h3>
        <p>{note}</p>
      </div>
      <ol className="wh-flow-steps" style={vars({ "--wh-flow-count": String(steps.length) })}>
        {steps.map(({ icon: Icon, title: stepTitle, detail, at, status, buzz }) => (
          <li key={stepTitle} className={buzz ? "wh-flow-step wh-flow-buzz" : "wh-flow-step"} style={vars({ "--wh-flow-at": `${at}s` })}>
            <span className="wh-flow-icon"><Icon size={20} aria-hidden="true" /></span>
            <div>
              <p className="wh-flow-title">{stepTitle}</p>
              <p className="wh-flow-detail">{detail}</p>
              {status ? (
                <p className="wh-flow-status" style={vars({ "--wh-flow-at": `${status.at}s` })}>
                  <Check size={14} aria-hidden="true" /> {status.label}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {aside}
    </figure>
  );
}

// The brief's primary journey: an "ask me first" calendar change, approved on the phone.
const ASK_FIRST: readonly FlowStep[] = [
  { icon: Bot, title: "Claude asks", detail: "“Add Moving day to my calendar.”", at: 0 },
  { icon: ShieldCheck, title: "Warthog checks your rules", detail: "Your rule: ask me before calendar changes.", at: 0.8 },
  {
    icon: Smartphone,
    title: "Your phone buzzes",
    detail: "Claude wants to add “Moving day” to your calendar on 1 Dec.",
    at: 2,
    buzz: true,
    status: { label: "You approved", at: 3 },
  },
  { icon: CalendarCheck, title: "Warthog adds the event", detail: "Claude gets the result. Your calendar connection stays with Warthog.", at: 4 },
  { icon: ListChecks, title: "It’s on the record", detail: "The request, your decision and the outcome, in one timeline.", at: 5.2 },
];

export function AskFirstFlow() {
  return <Flow id="ask-first" title="Ask me first, step by step" note="Illustration · example request" cycle={8} steps={ASK_FIRST} />;
}

// The brief's shared memory: one agent saves it, another agent you allowed uses it later.
const SHARED_MEMORY: readonly FlowStep[] = [
  { icon: Bot, title: "Claude learns you’re moving", detail: "It saves a memory to Warthog.", at: 0 },
  { icon: BookOpen, title: "“Moving on 1 Dec”", detail: "Saved by Claude · shared", at: 0.65 },
  { icon: Bot, title: "ChatGPT picks it up", detail: "A week later it finds subscriptions to cancel before the move, without asking again.", at: 2.6 },
];

export function SharedMemoryFlow() {
  return (
    <Flow
      id="shared-memory"
      title="Tell one agent, and the others you allow already know"
      note="Illustration · example memory"
      cycle={6.5}
      steps={SHARED_MEMORY}
      aside={
        <p className="wh-flow-aside">
          <LockKeyhole size={16} aria-hidden="true" /> An agent you haven’t allowed to read shared memory never sees it.
        </p>
      }
    />
  );
}
