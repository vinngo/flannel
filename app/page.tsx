import { Chat } from "./_components/Chat";
import { LinkAccount } from "./_components/LinkAccount";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <span className="font-semibold tracking-tight">Flannel</span>
          <LinkAccount />
        </div>
      </header>
      <Chat />
    </div>
  );
}
