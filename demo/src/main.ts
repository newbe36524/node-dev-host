interface BuildStatus {
  state: string;
  builds: number;
  finishedAt?: string;
}

const app = document.querySelector<HTMLElement>("#app")!;

async function render(): Promise<void> {
  const res = await fetch("/__dev-host/status.json", { cache: "no-store" });
  const status: BuildStatus = await res.json();
  app.innerHTML = `
    <h1>node-dev-host demo</h1>
    <p>This page was built from <code>/workspace/src/main.ts</code> inside the container.</p>
    <p>Edit that file and the container rebuilds <code>dist</code> by itself.</p>
    <pre>${JSON.stringify(status, null, 2)}</pre>`;
}

void render();
setInterval(() => void render(), 3000);
