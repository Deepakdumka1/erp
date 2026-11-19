"""A small Decision Tree model, kept separate so its logic is easy to explain."""
import random
import numpy as np
from sklearn.tree import DecisionTreeClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, confusion_matrix

FEATURES = ["average_marks", "attendance", "assignment_completion"]
LABELS = ["Low", "Medium", "High"]
_model = None
_report = None


def _rule_label(marks, attendance, assignments):
    """This simple rule creates labels for demo training data; it is not real-world truth."""
    score = 0.45 * marks + 0.35 * attendance + 0.20 * assignments
    if score < 55:
        return "High"
    if score < 68:
        return "Medium"
    return "Low"


def get_model():
    """Train once on generated examples and keep a small test report for the UI."""
    global _model, _report
    if _model is None:
        rng = random.Random(21)
        rows, labels = [], []
        for _ in range(600):
            row = [rng.randint(30, 100), rng.randint(30, 100), rng.randint(0, 100)]
            rows.append(row)
            labels.append(_rule_label(*row))
        x_train, x_test, y_train, y_test = train_test_split(
            rows, labels, test_size=0.2, random_state=42, stratify=labels
        )
        _model = DecisionTreeClassifier(max_depth=4, random_state=42)
        _model.fit(x_train, y_train)
        predictions = _model.predict(x_test)
        matrix = confusion_matrix(y_test, predictions, labels=LABELS).tolist()
        accuracy = accuracy_score(y_test, predictions)
        _report = {
            "test_rows": len(y_test),
            "accuracy": float(accuracy),
            "labels": LABELS.copy(),
            "confusion_matrix": matrix,
            "note": "Evaluated on synthetic rule-generated examples, not real student outcomes.",
        }
    return _model, _report


def predict_risk(marks, attendance, assignments):
    model, _ = get_model()
    values = np.array([[marks, attendance, assignments]])
    risk = str(model.predict(values)[0])
    reasons = []
    if marks < 60:
        reasons.append(f"Average marks are {marks:.0f}%, below 60%.")
    if attendance < 75:
        reasons.append(f"Attendance is {attendance:.0f}%, below the 75% reference.")
    if assignments < 70:
        reasons.append(f"Assignment completion is {assignments:.0f}%, below 70%.")
    if not reasons:
        reasons.append("The three tracked indicators are currently at or above their reference levels.")
    return {"level": risk, "reasons": reasons}
