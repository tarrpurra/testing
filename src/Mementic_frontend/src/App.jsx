// import { useState } from 'react';
// import { Mementic_backend } from 'declarations/Mementic_backend';

import { Routes, Route } from "react-router-dom";
import Index from "./Pages/index";
import Login from "./Pages/Login";
import Landing from "./Pages/Landing";
import MyPlace from "./Pages/MyPlace";
import PreMarketplace from "./Pages/PreMarketplace";
import Portfolio from "./Pages/Portfolio";
import Wallet_Page from "./Pages/Wallet";
import Marketplace from "./Pages/Marketplace";
import Auction from "./Pages/Auction";
import MemeNFTPlace from "./Pages/MemeNFTPlace";
import Feedback from "./Pages/Feedback";
import NotFound from "./Pages/NotFound";
import { ToastContainer } from "./components/Toast";
import { AuthProvider } from "./contexts/AuthContext";
import { ToastProvider, useToastContext } from "./contexts/ToastContext";
import "@nfid/identitykit/react/styles.css";
import { IdentityKitProvider } from "@nfid/identitykit/react";

// Component to display toasts
const ToastDisplay = () => {
  const { toasts, dismissToast } = useToastContext();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
};

function App() {

  return (
    <ToastProvider>
      <IdentityKitProvider
        signerClientOptions={{
          targets: ["g3bm6-baaaa-aaaaa-qcexq-cai"] // **IMPORTANT**: these are *your* canisters, not ledger canisters
        }}>
        <AuthProvider>
          <ToastDisplay />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/landing" element={<Landing />} />
            <Route path="/myplace" element={<MyPlace />} />
            <Route path="/pre-marketplace" element={<PreMarketplace />} />
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/auction" element={<Auction />} />
            <Route path="/meme-nft" element={<MemeNFTPlace />} />
            <Route path="/feedback" element={<Feedback />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/wallet" element={<Wallet_Page />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </IdentityKitProvider>
    </ToastProvider>
  );
}

export default App;
