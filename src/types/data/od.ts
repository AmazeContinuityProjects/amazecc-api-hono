export type odItem = {
    slNo: string,
    type: string,
    reason: string,
    basis: string,
    date: string,
    time: string,
    remarks: string,
}

export type odDetails = {
    semesterId: string,
    totalCount: number,
    note: string | null,
    records: odItem[],
}
