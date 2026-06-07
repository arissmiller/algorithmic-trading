import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiFetch";
import { API_PREFIX } from "./constants";

export function useApiHealth() {
  const [serverOnline, setServerOnline] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const response = await apiFetch(`${API_PREFIX}/health`);
        setServerOnline(response.ok);
      } catch {
        setServerOnline(false);
      }
    }

    void check();
    const intervalId = window.setInterval(() => {
      void check();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, []);

  return serverOnline;
}
