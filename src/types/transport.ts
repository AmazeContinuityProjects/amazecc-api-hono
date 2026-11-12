export interface BusRoute {
  id: number;
  routeNumber: string;
  routeName: string;
  type: 'AC' | 'Non-AC';
  driverName: string;
  driverPhone: string;
  whatsappGroup: string;
  busLocation: string;
  supervisorName: string;
  supervisorPhone: string;
  driverInchargeName: string;
  driverInchargePhone: string;
  stops: BusStop[];
  placements: BusPlacement[];
  createdAt: string;
  updatedAt: string;
}

export interface BusStop {
  stopOrder: number;
  stopName: string;
  pickupTime: string;
}

export interface BusPlacement {
  dispersalTime: '5PM' | '6PM';
  zone: string;
}

export interface BusStudent {
  id: number;
  routeNumber: string;
  registrationNumber: string;
  applicationNumber: string;
  destination: string;
}

export interface TransportRule {
  id: number;
  ruleNumber: number;
  content: string;
}

export interface BusRouteInput {
  routeNumber: string;
  routeName: string;
  type: 'AC' | 'Non-AC';
  driverName?: string;
  driverPhone?: string;
  whatsappGroup?: string;
  busLocation?: string;
  supervisorName?: string;
  supervisorPhone?: string;
  driverInchargeName?: string;
  driverInchargePhone?: string;
  stops?: BusStop[];
  placements?: BusPlacement[];
}

export interface TransportRuleInput {
  ruleNumber: number;
  content: string;
}

export interface BusStudentInput {
  routeNumber: string;
  registrationNumber: string;
  applicationNumber?: string;
  destination?: string;
}
