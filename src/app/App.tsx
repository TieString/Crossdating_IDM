import "./App.css";
import Home from "@/pages/Home";
import { SettingsProvider } from "@/features/settings/SettingsContext";

function App() {
  return (
    <SettingsProvider>
      <main className="app-container">
        <Home />
      </main>
    </SettingsProvider>
  );
}

export default App;
