export interface ReportSummary {
  id: string;
  name: string;
  createdAt: string;
  category: 'operations' | 'security' | 'compliance';
}

export const listReports = (): ReportSummary[] => {
  return [
    {
      id: 'rpt-001',
      name: 'Weekly Operations',
      createdAt: '2026-02-16T00:00:00Z',
      category: 'operations',
    },
  ];
};

export const getReportById = (id: string): ReportSummary | undefined => {
  return listReports().find((report) => report.id === id);
};
