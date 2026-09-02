import { HashRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { HomeNew } from './pages/HomeNew'
import { AddCMSPage } from './pages/AddCMS'
import { HistoryPage } from './pages/History'
import { AboutPage } from './pages/About'
import { MiaobiTab } from './pages/Miaobi'
import { BookOpen, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

function TabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const isMiaobi = location.pathname === '/miaobi'

  return (
    <div className="flex items-stretch border-b border-border bg-background sticky top-0 z-10">
      <div
        className="flex items-center justify-center w-9 shrink-0 border-r border-border"
        title="妙笔"
      >
        <span
          style={{
            width: 20, height: 20, background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
            fontFamily: '"Noto Serif SC","Songti SC",serif', fontSize: 12, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 3, transform: 'rotate(6deg)',
          }}
        >
          妙
        </span>
      </div>
      <button
        onClick={() => navigate('/')}
        className={cn(
          'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
          !isMiaobi
            ? 'text-primary border-primary'
            : 'text-muted-foreground border-transparent hover:text-foreground'
        )}
      >
        <Globe className="w-3.5 h-3.5" />
        <span style={{ fontFamily: '"Noto Serif SC","Songti SC",serif', letterSpacing: 1 }}>页面同步</span>
      </button>
      <button
        onClick={() => navigate('/miaobi')}
        className={cn(
          'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors',
          isMiaobi
            ? 'text-primary border-primary'
            : 'text-muted-foreground border-transparent hover:text-foreground'
        )}
      >
        <BookOpen className="w-3.5 h-3.5" />
        <span style={{ fontFamily: '"Noto Serif SC","Songti SC",serif', letterSpacing: 1 }}>妙笔稿件库</span>
      </button>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <div className="flex flex-col h-full min-h-[500px]">
        <TabBar />
        <Routes>
          <Route path="/" element={<HomeNew />} />
          <Route path="/miaobi" element={<MiaobiTab onOpenSettings={() => window.location.hash = '/'} />} />
          <Route path="/add-cms" element={<AddCMSPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
