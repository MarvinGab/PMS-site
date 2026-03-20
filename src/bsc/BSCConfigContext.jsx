import { createContext, useContext, useState } from 'react';

export const PRESET_PERSPECTIVE_COLORS = [
  '#2563EB',
  '#0F766E',
  '#D97706',
  '#7C3AED',
  '#DC2626',
  '#4F46E5',
];

export const GRADE_VISIBILITY_OPTIONS = [
  'All grades',
  'L2 and above',
  'L3 and above',
  'L4 and above',
  'Custom',
];

export const ORG_GRADE_OPTIONS = ['L1', 'L2', 'L3', 'L4', 'M1', 'M2', 'CXO'];
export const ORG_ATTRIBUTE_VALUES = {
  Department: ['Sales', 'Marketing', 'Finance', 'HR', 'Operations', 'Product', 'Engineering', 'Customer Success'],
  Designation: ['Analyst', 'Senior Analyst', 'Manager', 'Senior Manager', 'Director'],
  'Grade/Band': ['L1', 'L2', 'L3', 'L4', 'M1', 'M2'],
  'Cost Center': ['CC-100', 'CC-200', 'CC-300', 'CC-400'],
  Location: ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Remote'],
  'Employment type': ['Full-time', 'Contract', 'Consultant', 'Part-time'],
};

let perspectiveSeed = 4;
let kraSeed = 2;
let kpiSeed = 2;

export function createPerspective(overrides = {}) {
  perspectiveSeed += 1;
  return {
    id: `perspective-${perspectiveSeed}`,
    name: '',
    weightage: 0,
    color: PRESET_PERSPECTIVE_COLORS[perspectiveSeed % PRESET_PERSPECTIVE_COLORS.length],
    description: '',
    strategicObjective: '',
    ...overrides,
  };
}

export function createKPI(overrides = {}) {
  kpiSeed += 1;
  return {
    id: `kpi-${kpiSeed}`,
    name: '',
    unit: 'number',
    direction: 'higher',
    preFillTarget: false,
    targetValue: '',
    ...overrides,
  };
}

export function createKRA(overrides = {}) {
  kraSeed += 1;
  return {
    id: `kra-${kraSeed}`,
    name: '',
    description: '',
    perspectiveId: 'perspective-1',
    tags: [],
    secondaryTags: [],
    weightage: 0,
    status: 'draft',
    includeKPIs: false,
    kpis: [],
    ...overrides,
  };
}

export const DEFAULT_BSC_CONFIG = {
  framework: 'bsc',
  perspectives: [
    createPerspective({
      id: 'perspective-1',
      name: 'Financial',
      weightage: 25,
      color: PRESET_PERSPECTIVE_COLORS[0],
      description: 'Business, revenue, and cost outcomes.',
      strategicObjective: 'Drive profitable growth with disciplined financial stewardship.',
    }),
    createPerspective({
      id: 'perspective-2',
      name: 'Customer',
      weightage: 25,
      color: PRESET_PERSPECTIVE_COLORS[1],
      description: 'Client satisfaction, retention, and service quality.',
      strategicObjective: 'Improve customer trust, responsiveness, and measurable satisfaction.',
    }),
    createPerspective({
      id: 'perspective-3',
      name: 'Internal Process',
      weightage: 25,
      color: PRESET_PERSPECTIVE_COLORS[2],
      description: 'Execution efficiency, controls, and operational excellence.',
      strategicObjective: 'Strengthen internal delivery quality, timeliness, and process discipline.',
    }),
    createPerspective({
      id: 'perspective-4',
      name: 'Learning & Growth',
      weightage: 25,
      color: PRESET_PERSPECTIVE_COLORS[3],
      description: 'Capability building, innovation, and future readiness.',
      strategicObjective: 'Build capability depth and encourage continuous improvement.',
    }),
  ],
  showStrategicObjectives: true,
  objectiveVisibilityGrade: 'All grades',
  customVisibleGrades: [],
  differentiatorEnabled: true,
  differentiatorLabel: '',
  differentiatorField: 'Department',
  differentiatorCustomField: '',
  secondaryDifferentiatorEnabled: false,
  secondaryDifferentiatorLabel: '',
  secondaryDifferentiatorField: 'Department',
  secondaryDifferentiatorCustomField: '',
  preFillMode: 'kras-only',
  limits: {
    maxKPIsPerKRA: 5,
  },
  kras: [
    createKRA({
      id: 'kra-1',
      name: 'Revenue growth',
      description: 'Drive topline growth through stronger conversion and account expansion.',
      perspectiveId: 'perspective-1',
      tags: ['Sales'],
      weightage: 30,
      status: 'active',
      includeKPIs: true,
      kpis: [
        createKPI({
          id: 'kpi-1',
          name: 'Quarterly revenue attainment',
          unit: 'currency',
          direction: 'higher',
          preFillTarget: true,
          targetValue: '2500000',
        }),
      ],
    }),
    createKRA({
      id: 'kra-2',
      name: 'Customer retention',
      description: 'Improve retention and satisfaction for priority accounts.',
      perspectiveId: 'perspective-2',
      tags: [],
      weightage: 20,
      status: 'draft',
      includeKPIs: false,
      kpis: [],
    }),
  ],
};

const BSCConfigContext = createContext(null);

export function BSCConfigProvider({ children }) {
  const [bscConfig, setBscConfig] = useState(DEFAULT_BSC_CONFIG);

  return (
    <BSCConfigContext.Provider value={{ bscConfig, setBscConfig }}>
      {children}
    </BSCConfigContext.Provider>
  );
}

export function useBSCConfig() {
  const context = useContext(BSCConfigContext);
  if (!context) {
    throw new Error('useBSCConfig must be used within a BSCConfigProvider');
  }
  return context;
}
