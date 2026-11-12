export type EffectiveGrade = {
  basketTitle: string;
  courseType: string;
  distributionType: string;
  creditsEarned: string;
  grade: string;
}

export type CurriculumItem = {
  basketTitle: string;
  creditsRequired: string;
  creditsEarned: string;
}

type GradeCounts = {
  S?: number;
  A?: number;
  B?: number;
  C?: number;
  D?: number;
  E?: number;
  F?: number;
  N?: number;
}

export type CGPA = {
  grades?: GradeCounts;
  /**
   * Credits Registered, from the CGPA Details table.
   *
   * Registered is not earned and not required: it is the credits the student
   * has enrolled in so far, so it sits *below* `creditsEarned` mid-programme
   * only when a course is failed or withdrawn.
   */
  creditsRegistered?: string;
  /** Credits Earned — the denominator of the published CGPA. */
  creditsEarned?: string;
  /**
   * The CGPA VTOP itself published, as a string like `"9.62"`.
   *
   * This was on the page all along, in the row immediately left of the letter
   * counts, and the parser read only the counts. It is the authority: the
   * credit-weighted figure the app can derive from `effectiveGrades` is a
   * reconstruction of this number, not a substitute for it.
   */
  cgpa?: string;
}

type feedbackCategoryStatus = {
  Curriculum: boolean;
  Course: boolean;
}

export type FeedbackStatus = {
  MidSem: feedbackCategoryStatus;
  EndSem: feedbackCategoryStatus;
}