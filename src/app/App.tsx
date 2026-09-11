import "./App.css";
import Home from "@/pages/Home";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import { UpdateNotice } from "@/features/update/UpdateNotice";

function App() {
  return (
    <SettingsProvider>
      <main className="app-container">
        <Home />
      </main>
      <UpdateNotice />
    </SettingsProvider>
  );
}

export default App;
