import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startController } from "./controller";
import "./styles.css";

startController();
createRoot(document.getElementById("root")!).render(<App />);
