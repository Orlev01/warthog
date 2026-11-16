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

// Every request makes a round trip: out to the service, and its answer back to the agent the
// same way. A request pulse is drawn in the picture's colour and its answer in the text colour.
// Each wire crossing takes one leg; public.css spends exactly that share of the cycle moving
// (wh-relay-* 7.5% = RELAY.leg / RELAY.cycle, wh-tangle-* 4% = TANGLE.leg / TANGLE.cycle).
//
// With Warthog, one request starts per beat. Its answer reaches Warthog just as the next request
// does, so each ring marks a request being checked and an answer heading back: two pulses in
// flight, never more.
const RELAY = { leg: 0.9, check: 0.3, serve: 0.3, beat: 2.4, cycle: 12 }; // beat = 2 legs + check + serve
// Without Warthog, each line gets one trip per cycle and a trip starts every step, so two or
// three are in flight and each lights its own line long enough to follow it through the tangle.
const TANGLE = { leg: 1.2, serve: 0.3, step: 1.2, cycle: 30 }; // cycle = 25 lines × step

const seconds = (value: number) => `${value.toFixed(2)}s`;

// Lines carry their drawn length so every pulse is the same size on screen: public.css parks a
// 10-unit dash just before the start, and --wh-pulse-end parks it this far past the end, clear
// of its round cap.
const PULSE_PARK = 3;
type Point = readonly [number, number];
type Line = { d: string; length: number };
type Wire = Line & { key: string; send: number; reply: number };

function straight(from: Point, to: Point): Line {
  return { d: `M${from} L${to}`, length: Math.hypot(to[0] - from[0], to[1] - from[1]) };
}

function curve(from: Point, c1: Point, c2: Point, to: Point): Line {
  const at = (t: number): Point => {
    const u = 1 - t;
    const mix = (k: 0 | 1) => u * u * u * from[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * to[k];
    return [mix(0), mix(1)];
  };
  let length = 0;
  for (let step = 1, last = from; step <= 32; step += 1) {
    const next = at(step / 32);
    length += Math.hypot(next[0] - last[0], next[1] - last[1]);
    last = next;
  }
  return { d: `M${from} C${c1} ${c2} ${to}`, length };
}

const end = (wire: Wire) => (-(wire.length + PULSE_PARK)).toFixed(1);

// One line per connection, then a request and an answer pulse on each, drawn over it. A lit line
// brightens for its own trip (the tangle; Warthog's lines are bright already).
function Wires({ wires, lit = false }: { wires: readonly Wire[]; lit?: boolean }) {
  return (
    <>
      {wires.map((wire) => (
        <path key={wire.key} className="wh-diagram-wire" d={wire.d} data-wire="" style={lit ? vars({ "--wh-pulse-delay": seconds(wire.send) }) : undefined} />
      ))}
      {wires.map((wire) => (
        <React.Fragment key={wire.key}>
          <path className="wh-diagram-pulse" d={wire.d} data-pulse="request" style={vars({ "--wh-pulse-delay": seconds(wire.send), "--wh-pulse-end": end(wire) })} />
          <path className="wh-diagram-pulse" d={wire.d} data-pulse="answer" style={vars({ "--wh-pulse-delay": seconds(wire.reply), "--wh-pulse-end": end(wire) })} />
        </React.Fragment>
      ))}
    </>
  );
}

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

// Every agent wired straight to every service: 25 lines. Trip n runs from agent 2n mod 5, and
// across each run of five trips the services shift by one, so every line gets exactly one turn
// (5 is prime) and consecutive trips cross the picture at new angles.
function WithoutWarthog() {
  const wires: Wire[] = Array.from({ length: AGENTS.length * SERVICES.length }, (_, n) => {
    const i = (2 * n) % AGENTS.length;
    const j = (3 * i + Math.floor(n / AGENTS.length) + 1) % SERVICES.length;
    const send = n * TANGLE.step;
    return { key: `${i}-${j}`, ...straight([LEFT_X + PILL_W, ROW(i)], [RIGHT_X, ROW(j)]), send, reply: send + TANGLE.leg + TANGLE.serve };
  });
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Five agents, each connected separately to five services: 25 crossing lines." focusable="false" style={vars({ "--wh-pulse-cycle": seconds(TANGLE.cycle) })}>
      <Wires wires={wires} lit />
      <Pills />
    </svg>
  );
}

// Agents connect to Warthog and Warthog connects to the services: 10 lines. Agent i's request
// reaches Warthog, the ring marks the check, it goes on to service (i + 2) mod 5, and the answer
// comes back through Warthog to agent i.
function WithWarthog() {
  const { leg, check, serve, beat } = RELAY;
  const inbound: Wire[] = AGENTS.map((_, i) => {
    const [x0, x1] = [LEFT_X + PILL_W, HUB.x - HUB.r];
    const start = i * beat;
    return { key: `in-${i}`, ...curve([x0, ROW(i)], [x0 + 16, ROW(i)], [x1 - 16, HUB.y], [x1, HUB.y]), send: start, reply: start + 3 * leg + 2 * check + serve };
  });
  const outbound: Wire[] = SERVICES.map((_, j) => {
    const [x0, x1] = [HUB.x + HUB.r, RIGHT_X];
    const start = ((j + 3) % AGENTS.length) * beat;
    return { key: `out-${j}`, ...curve([x0, HUB.y], [x0 + 16, HUB.y], [x1 - 16, ROW(j)], [x1, ROW(j)]), send: start + leg + check, reply: start + 2 * leg + check + serve };
  });
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Five agents connect to Warthog, and Warthog connects to five services: 10 lines." focusable="false" style={vars({ "--wh-pulse-cycle": seconds(RELAY.cycle) })}>
      <Wires wires={[...inbound, ...outbound]} />
      <circle className="wh-diagram-ring" cx={HUB.x} cy={HUB.y} r={HUB.r} style={vars({ "--wh-ring-period": seconds(beat), "--wh-ring-delay": seconds(leg) })} />
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
        <figcaption>Each agent signs in to each service on its own, and each answer comes straight back down that line. A new agent means connecting every service again.</figcaption>
      </figure>
      <figure className="wh-diagram wh-diagram-with" aria-labelledby="diagram-with-title" data-motion-surface>
        <div className="wh-diagram-head">
          <h3 id="diagram-with-title">With Warthog</h3>
          <span className="wh-diagram-count">10 connections, one place</span>
        </div>
        <div className="wh-diagram-columns" aria-hidden="true"><span>Agents</span><span>Services</span></div>
        <WithWarthog />
        <figcaption>Each service connects once. Each agent connects only to Warthog, which checks every request against what you allowed and passes the answer back.</figcaption>
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
