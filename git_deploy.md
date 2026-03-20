# 🚀 GitHub Deploy ინსტრუქცია

## Production-ზე ატვირთვა (3 ბრძანება)

### 1️⃣ დავამატოთ ფაილები
```bash
git add .
```

### 2️⃣ შევქმნათ commit (სწორი author-ით)
```bash
git commit --author="infolegalge <infolegalge@gmail.com>" -m "თქვენი commit შეტყობინება"
```

### 3️⃣ ავტვირთოთ production-ზე
```bash
git push production main --force
```

---

## 📝 მაგალითები

### ახალი ფიჩის დამატება:
```bash
git add .
git commit --author="infolegalge <infolegalge@gmail.com>" -m "Add new feature: user dashboard"
git push production main --force
```

### ბაგის გამოსწორება:
```bash
git add .
git commit --author="infolegalge <infolegalge@gmail.com>" -m "Fix: resolve login loop issue"
git push production main --force
```

### სტილის ცვლილება:
```bash
git add .
git commit --author="infolegalge <infolegalge@gmail.com>" -m "Update contact information"
git push production main --force
```

---

## ⚠️ მნიშვნელოვანი

- **Author:** ყოველთვის გამოიყენეთ `--author="infolegalge <infolegalge@gmail.com>"`
- **Force Push:** `--force` საჭიროა, რადგან Vercel team member-ები არ ვართ
- **Commit Message:** გასაგები და დესკრიპტიული იყოს

---

## ✅ რა მოხდება ატვირთვის შემდეგ?

1. კოდი აიტვირთება `infolegalge/legal.ge-production` repository-ში
2. Vercel ავტომატურად დააბილდავს ახალ ვერსიას
3. 2-3 წუთში ცვლილებები live-ზე გამოჩნდება

---

## 🔍 სტატუსის შემოწმება

```bash
# ვნახოთ რა ფაილები შეიცვალა
git status

# ვნახოთ ბოლო commit-ები
git log --oneline -5

# ვნახოთ რა remote-ები გვაქვს
git remote -v
```
