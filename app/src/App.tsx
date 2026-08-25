import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { StatusPage } from './pages/StatusPage'
import { PickTeamPage } from './pages/PickTeamPage'
import { TransfersPage } from './pages/TransfersPage'
import { PlannerPage } from './pages/PlannerPage'
import { MorePage } from './pages/MorePage'
import { AddPlayerPage } from './pages/AddPlayerPage'
import { ConfirmTransfersPage } from './pages/ConfirmTransfersPage'
import { PriceChangesPage } from './pages/PriceChangesPage'
import { ModelChangesPage } from './pages/ModelChangesPage'

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<StatusPage />} />
        <Route path="/pick-team" element={<PickTeamPage />} />
        <Route path="/transfers" element={<TransfersPage />} />
        <Route path="/planner" element={<PlannerPage />} />
        <Route path="/more" element={<MorePage />} />
        <Route path="/add-player" element={<AddPlayerPage />} />
        <Route path="/confirm-transfers" element={<ConfirmTransfersPage />} />
        <Route path="/price-changes" element={<PriceChangesPage />} />
        <Route path="/model-changes" element={<ModelChangesPage />} />
      </Routes>
    </BrowserRouter>
  )
}
