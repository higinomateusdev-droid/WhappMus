import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "@/pages/Home";
import Landing from "@/pages/Landing";
import Auth from "@/pages/Auth";

function Router() {
  return <Switch><Route path="/" component={Landing} /><Route path="/auth" component={Auth} /><Route path="/lab" component={Home} /><Route path="/404" component={NotFound} /><Route component={NotFound} /></Switch>;
}

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster theme="dark" /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
