export interface EventLogProps {
  events: string[];
  maxEvents?: number | null;
  showHeader?: boolean;
}

export function EventLog({ events, maxEvents = 8, showHeader = true }: EventLogProps) {
  const visibleEvents = maxEvents === null ? events : events.slice(-maxEvents);

  return (
    <section className="event-log">
      {showHeader ? <h2>Events</h2> : null}
      {events.length === 0 ? (
        <p className="muted">No terminal events yet.</p>
      ) : (
        <ol>
          {visibleEvents.map((event, index) => (
            <li key={`${event}-${index}`}>{event}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
