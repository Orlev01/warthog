# Services on for new agents; the first grant keeps reads on

Decision date: 23 November 2026.

The founder connected a new agent (Meta's Muse) and expected it to reach the services already
connected in Warthog. It reached none of them, for two reasons:

- **Nothing was ticked.** The consent screen lists the person's services but never ticks one, so an
  agent approved without ticking any gets no services. That is the brief's opt-in, but with several
  agents and the same few services, every new agent needs the same clicks.
- **Granting afterwards still gave no tools.** An agent connected with no services stores its
  "Defaults for every service" as reads off and changes off. The Connectors section of the agent's
  page always sends those two controls as shown, and they overwrote the grant's own defaults. So
  the services ticked there said "can use it", yet the agent was served none of their tools.

## Decision

1. **"On for new agents", per account.** Each account under Connectors › Your services has a
   switch.
   - On means every agent connected afterwards starts with that service ticked on its consent
     screen (or access-key screen), and approving grants it set to that account. The person can
     still untick it before approving.
   - Agents already connected don't change. Global rules still apply to every agent.
   - An agent uses one account of each service
     ([accounts ADR](google-published-and-accounts.md)), so at most one account of a service is on.
     Turning on a second one moves the switch to it.
   - Disconnecting an account removes its switch with it.
   - Each change is recorded in Activity as an agent defaults change, naming the account.
   - The Minimal starting set still grants no services: choosing it unticks them, as before.
2. **The first grant takes consent's defaults.** When an agent goes from no granted service to at
   least one on its page, a "Defaults for every service" control the person left as it was takes
   what consent gives: reading on, changes "ask me first". A control the person changed in the same
   save is kept, and once a service is granted every save keeps what the form sends.

## Not done

- **Agents already connected aren't repaired.** An agent whose services were granted while this was
  broken keeps reads and changes off until the person turns them on, since that might have been
  deliberate.
- **Several accounts of one service per agent** is still not done (see the accounts ADR).

## Consequences

- **Data:** migration 0119 adds `connections.default_for_agents` with a partial unique index of one
  per person and service. There are no new runtime settings.
- **Brief:** the Agent consent screen requirement is amended (services on for new agents start
  ticked).
- **Design doc:** technical-design.md §7 links here.
