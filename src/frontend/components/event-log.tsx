export interface EventLogProps {
  events: string[];
}

export function EventLog({ events }: EventLogProps) {
  return (
    <section className="event-log">
      <h2>Events</h2>
      {events.length === 0 ? (
        <p className="muted">No terminal events yet.</p>
      ) : (
        <ol>
          {events.slice(-8).map((event, index) => (
            <li key={`${event}-${index}`}>{event}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
