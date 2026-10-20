import Link from "next/link";
import Shortcuts from "./_components/shortcuts";

export default function MeetingsWorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl">
      <Shortcuts />
      {children}
      <p className="mt-10 text-xs text-muted">
        Keys: <kbd>t</kbd> Today · <kbd>c</kbd> Calendar · <kbd>m</kbd> Meetings · <kbd>n</kbd> Notes · <kbd>i</kbd> Inbox · <kbd>/</kbd> Search ·{" "}
        <Link href="/meetings/connect" className="underline">
          Microsoft 365
        </Link>
      </p>
    </div>
  );
}
