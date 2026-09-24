import { HashRouter, Routes, Route } from 'react-router-dom'
import { AddCMSPage } from './pages/AddCMS'
import { HistoryPage } from './pages/History'
import { AboutPage } from './pages/About'
import { MiaobiTab } from './pages/Miaobi'
import { UpdateBanner } from './UpdateBanner'

export default function App() {
  return (
    <HashRouter>
      <div className="flex flex-col h-full min-h-[500px]">
        <UpdateBanner />
        <Routes>
          <Route path="/" element={<MiaobiTab />} />
          <Route path="/add-cms" element={<AddCMSPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
