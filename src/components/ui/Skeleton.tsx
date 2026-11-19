/** 9 + 5.1：书架首屏骨架卡片，禁用整页转圈。 */
export default function ShelfSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="shelf-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton skeleton-cover" />
          <div className="skeleton skeleton-line" style={{ width: "82%" }} />
          <div className="skeleton skeleton-line" style={{ width: "48%" }} />
        </div>
      ))}
    </div>
  );
}
