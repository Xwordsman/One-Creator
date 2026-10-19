import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import { Button, Loading, ToastProvider } from './components/ui';
import './styles.css';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Ideas = lazy(() => import('./pages/Ideas'));
const Materials = lazy(() => import('./pages/Materials'));
const Contents = lazy(() => import('./pages/Contents'));
const Editor = lazy(() => import('./pages/Editor'));
const Publishing = lazy(() => import('./pages/Publishing'));
const Jobs = lazy(() => import('./pages/Jobs'));
const Settings = lazy(() => import('./pages/Settings'));
const Studio = lazy(() => import('./pages/Studio'));
const AutomationDetail = lazy(() => import('./pages/AutomationDetail'));
const Discovery = lazy(() => import('./pages/Discovery'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Media = lazy(() => import('./pages/Media'));
const Workspace = lazy(() => import('./pages/Workspace'));
const Usage = lazy(() => import('./pages/Usage'));
const Notifications = lazy(() => import('./pages/Notifications'));
const wrap = (element: React.ReactNode) => <Suspense fallback={<Loading />}>{element}</Suspense>;
function RouteError() {
  const error = useRouteError();
  return (
    <div className="route-error">
      <h1>{isRouteErrorResponse(error) && error.status === 404 ? '这个页面还不存在' : '页面暂时遇到问题'}</h1>
      <p>已保存的内容仍在工作空间中。</p>
      <Button
        onClick={() => {
          window.location.href = '/';
        }}
      >
        回到工作台
      </Button>
    </div>
  );
}
const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: wrap(<Dashboard />) },
      { path: 'accounts', element: wrap(<Accounts />) },
      { path: 'ideas', element: wrap(<Ideas />) },
      { path: 'materials', element: wrap(<Materials />) },
      { path: 'contents', element: wrap(<Contents />) },
      { path: 'contents/:id', element: wrap(<Editor />) },
      { path: 'publishing', element: wrap(<Publishing />) },
      { path: 'jobs', element: wrap(<Jobs />) },
      { path: 'settings', element: wrap(<Settings />) },
      { path: 'studio', element: wrap(<Studio />) },
      { path: 'studio/tasks/:id', element: wrap(<AutomationDetail />) },
      { path: 'discovery', element: wrap(<Discovery />) },
      { path: 'analytics', element: wrap(<Analytics />) },
      { path: 'media', element: wrap(<Media />) },
      { path: 'workspace', element: wrap(<Workspace />) },
      { path: 'usage', element: wrap(<Usage />) },
      { path: 'notifications', element: wrap(<Notifications />) },
    ],
  },
]);
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
